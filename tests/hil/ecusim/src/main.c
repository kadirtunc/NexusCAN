/*
 * ecusim — virtual UDS ECU (test-only).
 *
 *   ecusim -i vcan0 -c config.json [--req 0x7E0] [--resp 0x7E8] [--func 0x7DF] [--fd]
 *          [--log events.jsonl]
 *
 * Signals:  SIGHUP  -> reload config file + full state reset (sockets reopened)
 *           SIGUSR1 -> full state reset from the current config (no file read)
 *           SIGTERM / SIGINT -> clean exit (all memory released, for LeakSanitizer)
 */
#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "ecusim.h"

static volatile sig_atomic_t g_stop = 0;
static volatile sig_atomic_t g_hup = 0;
static volatile sig_atomic_t g_usr1 = 0;

static void on_signal(int sig) {
    if (sig == SIGHUP) {
        g_hup = 1;
    } else if (sig == SIGUSR1) {
        g_usr1 = 1;
    } else {
        g_stop = 1;
    }
}

static void usage(const char *argv0) {
    (void)fprintf(stderr,
                  "usage: %s -i IFACE -c CONFIG.json [options]\n"
                  "  -i, --iface IFACE    CAN interface (default vcan0)\n"
                  "  -c, --config FILE    JSON configuration (required)\n"
                  "      --req ID         physical request CAN id  (default 0x7E0)\n"
                  "      --resp ID        physical response CAN id (default 0x7E8)\n"
                  "      --func ID        functional request CAN id (default 0x7DF)\n"
                  "      --fd             CAN-FD link layer (MTU 72, TX_DL 64, BRS)\n"
                  "  -l, --log FILE       JSON-lines event log (default stdout)\n",
                  argv0);
}

static int parse_id(const char *s, uint32_t *out) {
    char *end = NULL;
    errno = 0;
    unsigned long v = strtoul(s, &end, 0);
    if ((errno != 0) || (end == s) || (*end != '\0') || (v > 0x1FFFFFFFUL)) {
        return -1;
    }
    *out = (uint32_t)v;
    return 0;
}

typedef struct {
    ecu_t ecu;
    UDSServer_t srv;
    ecusim_tp_t tp;
    ecusim_tp_opts_t opts;
    const char *cfg_path;
} app_t;

static void server_reinit(app_t *a) {
    UDSServer_t *srv = &a->srv;
    (void)UDSServerInit(srv);
    srv->tp = &a->tp.hdl;
    srv->fn = ecu_event;
    srv->fn_data = &a->ecu;
    srv->p2_ms = a->ecu.cfg.p2_ms;
    srv->p2_star_ms = a->ecu.cfg.p2_star_ms;
    srv->s3_ms = a->ecu.cfg.s3_ms;
    uint32_t now = UDSMillis();
    srv->p2_timer = now - 1U;
    srv->s3_session_timeout_timer = now + srv->s3_ms;
    /* iso14229 is compiled with its 0x27 brute-force timers at 0; the configured boot delay is
     * applied here and the attempt counter / lockout are implemented in ecu.c */
    srv->sec_access_boot_delay_timer = (a->ecu.cfg.security_boot_delay_ms == 0U)
                                           ? (now - 1U)
                                           : (now + a->ecu.cfg.security_boot_delay_ms);
    srv->sec_access_auth_fail_timer = now - 1U;
    a->ecu.srv = srv;
}

static int open_tp(app_t *a) {
    a->opts.bs = a->ecu.cfg.isotp_bs;
    a->opts.stmin = a->ecu.cfg.isotp_stmin;
    a->opts.tx_padding = a->ecu.cfg.tx_padding;
    if (ecusim_tp_open(&a->tp, &a->opts) != 0) {
        return -1;
    }
    a->tp.user = &a->ecu;
    a->tp.on_rx = ecu_on_rx;
    a->tp.on_tx = ecu_on_tx;
    return 0;
}

static int full_reset(app_t *a) {
    ecu_state_free(&a->ecu);
    if (ecu_state_init(&a->ecu) != 0) {
        return -1;
    }
    server_reinit(a);
    return 0;
}

int main(int argc, char **argv) {
    static app_t app;
    const char *log_path = NULL;
    static const struct option longopts[] = {
        {"iface", required_argument, NULL, 'i'}, {"config", required_argument, NULL, 'c'},
        {"req", required_argument, NULL, 'R'},   {"resp", required_argument, NULL, 'T'},
        {"func", required_argument, NULL, 'F'},  {"fd", no_argument, NULL, 'f'},
        {"log", required_argument, NULL, 'l'},   {"help", no_argument, NULL, 'h'},
        {NULL, 0, NULL, 0}};

    (void)memset(&app, 0, sizeof(app));
    app.opts.ifname = "vcan0";
    app.opts.phys_rx = 0x7E0;
    app.opts.phys_tx = 0x7E8;
    app.opts.func_rx = 0x7DF;

    int c = 0;
    while ((c = getopt_long(argc, argv, "i:c:l:h", longopts, NULL)) != -1) {
        switch (c) {
        case 'i':
            app.opts.ifname = optarg;
            break;
        case 'c':
            app.cfg_path = optarg;
            break;
        case 'l':
            log_path = optarg;
            break;
        case 'f':
            app.opts.fd = true;
            break;
        case 'R':
        case 'T':
        case 'F': {
            uint32_t v = 0;
            if (parse_id(optarg, &v) != 0) {
                (void)fprintf(stderr, "invalid CAN id: %s\n", optarg);
                return 2;
            }
            if (c == 'R') {
                app.opts.phys_rx = v;
            } else if (c == 'T') {
                app.opts.phys_tx = v;
            } else {
                app.opts.func_rx = v;
            }
            break;
        }
        default:
            usage(argv[0]);
            return (c == 'h') ? 0 : 2;
        }
    }
    if (app.cfg_path == NULL) {
        usage(argv[0]);
        return 2;
    }
    if (log_open(log_path) != 0) {
        (void)fprintf(stderr, "cannot open log %s\n", log_path);
        return 2;
    }

    char err[256];
    if (cfg_load(app.cfg_path, &app.ecu.cfg, err, sizeof(err)) != 0) {
        (void)fprintf(stderr, "config error: %s\n", err);
        log_event("\"ev\":\"config_error\",\"msg\":\"%s\"", err);
        log_close();
        return 3;
    }
    if (ecu_state_init(&app.ecu) != 0) {
        (void)fprintf(stderr, "out of memory\n");
        return 4;
    }
    if (open_tp(&app) != 0) {
        (void)fprintf(stderr, "cannot open ISO-TP sockets on %s\n", app.opts.ifname);
        ecu_state_free(&app.ecu);
        cfg_free(&app.ecu.cfg);
        log_close();
        return 5;
    }
    server_reinit(&app);

    struct sigaction sa;
    (void)memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    (void)sigemptyset(&sa.sa_mask);
    (void)sigaction(SIGHUP, &sa, NULL);
    (void)sigaction(SIGUSR1, &sa, NULL);
    (void)sigaction(SIGTERM, &sa, NULL);
    (void)sigaction(SIGINT, &sa, NULL);

    log_event("\"ev\":\"ready\",\"pid\":%d,\"iface\":\"%s\",\"req\":%u,\"resp\":%u,\"func\":%u,"
              "\"fd\":%s,\"lib\":\"%s\"",
              (int)getpid(), app.opts.ifname, app.opts.phys_rx, app.opts.phys_tx, app.opts.func_rx,
              app.opts.fd ? "true" : "false", UDS_LIB_VERSION);

    int rc = 0;
    while (g_stop == 0) {
        if (g_hup != 0) {
            g_hup = 0;
            ecu_cfg_t ncfg;
            if (cfg_load(app.cfg_path, &ncfg, err, sizeof(err)) != 0) {
                log_event("\"ev\":\"reloaded\",\"ok\":false,\"msg\":\"%s\"", err);
            } else {
                ecusim_tp_close(&app.tp);
                ecu_state_free(&app.ecu);
                cfg_free(&app.ecu.cfg);
                app.ecu.cfg = ncfg;
                if ((ecu_state_init(&app.ecu) != 0) || (open_tp(&app) != 0)) {
                    log_event("\"ev\":\"reloaded\",\"ok\":false,\"msg\":\"init failed\"");
                    rc = 6;
                    break;
                }
                server_reinit(&app);
                log_event("\"ev\":\"reloaded\",\"ok\":true");
            }
        }
        if (g_usr1 != 0) {
            g_usr1 = 0;
            if (full_reset(&app) != 0) {
                rc = 6;
                break;
            }
            size_t n = ecusim_tp_drain(&app.tp);
            log_event("\"ev\":\"state_reset\",\"drained\":%zu", n);
        }

        UDSServerPoll(&app.srv);

        if (app.ecu.reset_pending != 0U) {
            uint8_t type = app.ecu.reset_pending;
            ecu_volatile_reset(&app.ecu);
            server_reinit(&app);
            size_t n = ecusim_tp_drain(&app.tp);
            log_event("\"ev\":\"ecu_reset\",\"type\":%u,\"dropped_requests\":%zu", type, n);
        }
    }

    log_event("\"ev\":\"exit\",\"rc\":%d", rc);
    ecusim_tp_close(&app.tp);
    ecu_state_free(&app.ecu);
    cfg_free(&app.ecu.cfg);
    log_close();
    return rc;
}
