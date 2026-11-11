/*
 * UDSTp_t implementation over Linux kernel ISO-TP sockets (CAN_ISOTP).
 *
 * Why not iso14229's own UDS_TP_ISOTP_SOCK transport (0.11.0)?
 *  - it never sets CAN_ISOTP_LL_OPTS, so CAN-FD (MTU 72 / TX_DL 64) is impossible;
 *  - it ignores the result of ioctl(SIOCGIFINDEX): an unknown interface silently binds to
 *    ifindex 0 (= all CAN interfaces);
 *  - it offers no padding / BS / STmin configuration and no hook to observe traffic.
 * The kernel still does all ISO 15765-2 segmentation, flow control and timing here.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <net/if.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <linux/can.h>
#include <linux/can/isotp.h>

#include "ecusim.h"

#ifndef SOL_CAN_ISOTP
#define SOL_CAN_ISOTP (SOL_CAN_BASE + CAN_ISOTP)
#endif

static canid_t mkid(uint32_t id) { return (id > 0x7FFU) ? (id | CAN_EFF_FLAG) : id; }

static int open_sock(const ecusim_tp_opts_t *o, uint32_t rx, uint32_t tx, bool listen_only) {
    int fd = socket(AF_CAN, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, CAN_ISOTP);
    if (fd < 0) {
        log_event("\"ev\":\"error\",\"what\":\"socket(CAN_ISOTP)\",\"errno\":%d,\"msg\":\"%s\"",
                  errno, strerror(errno));
        return -1;
    }

    struct can_isotp_options opts;
    (void)memset(&opts, 0, sizeof(opts));
    if (listen_only) {
        opts.flags |= CAN_ISOTP_LISTEN_MODE;
    }
    if (o->tx_padding >= 0) {
        opts.flags |= CAN_ISOTP_TX_PADDING;
        opts.txpad_content = (uint8_t)o->tx_padding;
    }
    struct can_isotp_fc_options fc = {.bs = o->bs, .stmin = o->stmin, .wftmax = 0};
    unsigned ifindex = if_nametoindex(o->ifname);

    if (ifindex == 0U) {
        log_event("\"ev\":\"error\",\"what\":\"if_nametoindex\",\"iface\":\"%s\"", o->ifname);
        goto fail;
    }
    if (setsockopt(fd, SOL_CAN_ISOTP, CAN_ISOTP_OPTS, &opts, sizeof(opts)) < 0) {
        goto fail_errno;
    }
    if (setsockopt(fd, SOL_CAN_ISOTP, CAN_ISOTP_RECV_FC, &fc, sizeof(fc)) < 0) {
        goto fail_errno;
    }
    if (o->fd) {
        struct can_isotp_ll_options ll = {.mtu = CANFD_MTU, .tx_dl = 64, .tx_flags = CANFD_BRS};
        if (setsockopt(fd, SOL_CAN_ISOTP, CAN_ISOTP_LL_OPTS, &ll, sizeof(ll)) < 0) {
            goto fail_errno;
        }
    }

    struct sockaddr_can addr;
    (void)memset(&addr, 0, sizeof(addr));
    addr.can_family = AF_CAN;
    addr.can_ifindex = (int)ifindex;
    addr.can_addr.tp.rx_id = mkid(rx);
    addr.can_addr.tp.tx_id = mkid(tx);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        goto fail_errno;
    }
    return fd;

fail_errno:
    log_event("\"ev\":\"error\",\"what\":\"isotp socket setup\",\"errno\":%d,\"msg\":\"%s\"", errno,
              strerror(errno));
fail:
    (void)close(fd);
    return -1;
}

static void check_sock_error(int fd, const char *which) {
    int pending = 0;
    socklen_t l = sizeof(pending);
    if ((getsockopt(fd, SOL_SOCKET, SO_ERROR, &pending, &l) == 0) && (pending != 0)) {
        log_event("\"ev\":\"isotp_error\",\"sock\":\"%s\",\"errno\":%d,\"msg\":\"%s\"", which,
                  pending, strerror(pending));
    }
}

static UDSErr_t tp_poll(UDSTp_t *hdl) {
    ecusim_tp_t *tp = (ecusim_tp_t *)hdl;
    struct pollfd p[2] = {{.fd = tp->phys_fd, .events = POLLIN}, {.fd = tp->func_fd, .events = POLLIN}};
    int r = poll(p, 2, 1); /* 1 ms pacing for UDSServerPoll() */
    if (r < 0) {
        return (errno == EINTR) ? UDS_OK : UDS_ERR_TPORT;
    }
    if ((p[0].revents & POLLERR) != 0) {
        check_sock_error(tp->phys_fd, "phys");
    }
    if ((p[1].revents & POLLERR) != 0) {
        check_sock_error(tp->func_fd, "func");
    }
    return UDS_OK;
}

static ssize_t read_once(int fd, uint8_t *buf, size_t bufsiz, const char *which) {
    ssize_t n = read(fd, buf, bufsiz);
    if (n < 0) {
        if ((errno != EAGAIN) && (errno != EWOULDBLOCK) && (errno != EINTR)) {
            log_event("\"ev\":\"isotp_error\",\"sock\":\"%s\",\"op\":\"read\",\"errno\":%d,"
                      "\"msg\":\"%s\"",
                      which, errno, strerror(errno));
        }
        return 0;
    }
    return n;
}

static UDSErr_t tp_recv(UDSTp_t *hdl, uint8_t *buf, size_t bufsiz, size_t *recvlen,
                        UDSSDU_t *info) {
    ecusim_tp_t *tp = (ecusim_tp_t *)hdl;
    UDSSDU_t sdu;
    (void)memset(&sdu, 0, sizeof(sdu));
    sdu.A_Mtype = UDS_A_MTYPE_DIAG;
    sdu.A_AE = UDS_TP_NOOP_ADDR;

    ssize_t n = read_once(tp->phys_fd, buf, bufsiz, "phys");
    if (n > 0) {
        sdu.A_TA = tp->phys_rx;
        sdu.A_SA = tp->phys_tx;
        sdu.A_TA_Type = UDS_A_TA_TYPE_PHYSICAL;
    } else {
        n = read_once(tp->func_fd, buf, bufsiz, "func");
        if (n > 0) {
            sdu.A_TA = tp->func_rx;
            sdu.A_SA = tp->phys_tx;
            sdu.A_TA_Type = UDS_A_TA_TYPE_FUNCTIONAL;
        }
    }
    *recvlen = (n > 0) ? (size_t)n : 0U;
    if ((n > 0) && (info != NULL)) {
        *info = sdu;
    }
    if ((n > 0) && (tp->on_rx != NULL)) {
        tp->on_rx(tp->user, buf, (size_t)n, &sdu);
    }
    return UDS_OK;
}

static UDSErr_t tp_send(UDSTp_t *hdl, const uint8_t *buf, size_t len, const UDSSDU_t *info) {
    ecusim_tp_t *tp = (ecusim_tp_t *)hdl;
    (void)info; /* responses always leave on the physical response id (also for functional reqs) */

    if ((tp->on_tx != NULL) && !tp->on_tx(tp->user, buf, len)) {
        return UDS_OK; /* dropped deliberately (fault injection) */
    }
    for (int tries = 0; tries < 2000; tries++) {
        ssize_t w = write(tp->phys_fd, buf, len);
        if (w == (ssize_t)len) {
            return UDS_OK;
        }
        if ((w < 0) && ((errno == EAGAIN) || (errno == EWOULDBLOCK) || (errno == EINTR))) {
            /* previous multi-frame transmission still in progress */
            struct pollfd p = {.fd = tp->phys_fd, .events = POLLOUT};
            (void)poll(&p, 1, 1);
            continue;
        }
        log_event("\"ev\":\"isotp_error\",\"sock\":\"phys\",\"op\":\"write\",\"errno\":%d,"
                  "\"msg\":\"%s\"",
                  errno, strerror(errno));
        return UDS_ERR_TPORT;
    }
    log_event("\"ev\":\"isotp_error\",\"sock\":\"phys\",\"op\":\"write\",\"msg\":\"timeout\"");
    return UDS_ERR_TPORT;
}

int ecusim_tp_open(ecusim_tp_t *tp, const ecusim_tp_opts_t *o) {
    (void)memset(tp, 0, sizeof(*tp));
    tp->hdl.send = tp_send;
    tp->hdl.recv = tp_recv;
    tp->hdl.poll = tp_poll;
    tp->phys_rx = o->phys_rx;
    tp->phys_tx = o->phys_tx;
    tp->func_rx = o->func_rx;
    tp->phys_fd = open_sock(o, o->phys_rx, o->phys_tx, false);
    /* functional requests are single frames: listen-only so we never emit FC on 0x7DF peers */
    tp->func_fd = open_sock(o, o->func_rx, o->phys_tx, true);
    if ((tp->phys_fd < 0) || (tp->func_fd < 0)) {
        ecusim_tp_close(tp);
        return -1;
    }
    return 0;
}

void ecusim_tp_close(ecusim_tp_t *tp) {
    if (tp->phys_fd >= 0) {
        (void)close(tp->phys_fd);
    }
    if (tp->func_fd >= 0) {
        (void)close(tp->func_fd);
    }
    tp->phys_fd = -1;
    tp->func_fd = -1;
}

size_t ecusim_tp_drain(ecusim_tp_t *tp) {
    uint8_t tmp[UDS_TP_MTU];
    size_t n = 0;
    for (;;) {
        ssize_t a = read(tp->phys_fd, tmp, sizeof(tmp));
        ssize_t b = read(tp->func_fd, tmp, sizeof(tmp));
        if ((a <= 0) && (b <= 0)) {
            break;
        }
        n += (size_t)(a > 0) + (size_t)(b > 0);
    }
    return n;
}
