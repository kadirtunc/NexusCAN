/*
 * ECU behaviour: iso14229 server event handler + transport hooks.
 *
 * iso14229 0.11.0 parses every request, enforces most length rules and builds the response
 * frame; this file supplies the application behaviour from the JSON configuration and fills
 * the gaps listed in README.md ("Kapsam").
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ecusim.h"

#define NRC_OK UDS_PositiveResponse

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

static bool sess_ok(const sess_list_t *l, uint8_t s) {
    if (l->n == 0U) {
        return true;
    }
    for (uint8_t i = 0; i < l->n; i++) {
        if (l->v[i] == s) {
            return true;
        }
    }
    return false;
}

static bool sec_ok(const ecu_t *e, uint8_t required) {
    return (required == 0U) || (e->srv->securityLevel == required);
}

static int find_did(const ecu_t *e, uint16_t id) {
    for (uint16_t i = 0; i < e->cfg.n_dids; i++) {
        if (e->cfg.dids[i].id == id) {
            return (int)i;
        }
    }
    return -1;
}

static int find_sec(const ecu_t *e, uint8_t level) {
    for (uint16_t i = 0; i < e->cfg.n_sec; i++) {
        if (e->cfg.sec[i].level == level) {
            return (int)i;
        }
    }
    return -1;
}

static int find_routine(const ecu_t *e, uint16_t id) {
    for (uint16_t i = 0; i < e->cfg.n_routines; i++) {
        if (e->cfg.routines[i].id == id) {
            return (int)i;
        }
    }
    return -1;
}

static const service_cfg_t *find_service(const ecu_t *e, uint8_t sid) {
    for (uint16_t i = 0; i < e->cfg.n_services; i++) {
        if (e->cfg.services[i].sid == sid) {
            return &e->cfg.services[i];
        }
    }
    return NULL;
}

static const session_cfg_t *find_session(const ecu_t *e, uint8_t id) {
    for (uint16_t i = 0; i < e->cfg.n_sessions; i++) {
        if (e->cfg.sessions[i].id == id) {
            return &e->cfg.sessions[i];
        }
    }
    return NULL;
}

/* region fully containing [addr, addr+size) with the requested capability */
static int find_region(const ecu_t *e, uint64_t addr, uint64_t size, bool want_download) {
    if (size == 0U) {
        return -1;
    }
    for (uint16_t i = 0; i < e->cfg.n_mem; i++) {
        const mem_region_cfg_t *r = &e->cfg.mem[i];
        if (want_download ? !r->downloadable : !r->readable) {
            continue;
        }
        if ((addr >= r->addr) && ((addr + size) <= ((uint64_t)r->addr + r->size))) {
            return (int)i;
        }
    }
    return -1;
}

static const uint8_t *did_current(ecu_t *e, int idx) {
    const did_cfg_t *d = &e->cfg.dids[idx];
    if (d->source == DID_SRC_ACTIVE_SESSION) {
        e->did_val[idx][0] = e->srv->sessionType;
    }
    return e->io_active[idx] ? e->io_val[idx] : e->did_val[idx];
}

static void put_be32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

int ecu_state_init(ecu_t *e) {
    const ecu_cfg_t *c = &e->cfg;
    size_t nd = c->n_dids ? c->n_dids : 1U;
    e->did_val = calloc(nd, sizeof(uint8_t *));
    e->io_val = calloc(nd, sizeof(uint8_t *));
    e->io_active = calloc(nd, sizeof(bool));
    e->sec = calloc(c->n_sec ? c->n_sec : 1U, sizeof(sec_state_t));
    e->rt = calloc(c->n_routines ? c->n_routines : 1U, sizeof(routine_state_t));
    e->fault_hits = calloc(c->n_faults ? c->n_faults : 1U, sizeof(uint32_t));
    e->mem = calloc(c->n_mem ? c->n_mem : 1U, sizeof(uint8_t *));
    e->dtc = calloc(c->n_dtcs ? c->n_dtcs : 1U, sizeof(dtc_state_t));
    if ((e->did_val == NULL) || (e->io_val == NULL) || (e->io_active == NULL) ||
        (e->sec == NULL) || (e->rt == NULL) || (e->fault_hits == NULL) || (e->mem == NULL) ||
        (e->dtc == NULL)) {
        return -1;
    }
    for (uint16_t i = 0; i < c->n_dids; i++) {
        e->did_val[i] = malloc(c->dids[i].len);
        e->io_val[i] = malloc(c->dids[i].len);
        if ((e->did_val[i] == NULL) || (e->io_val[i] == NULL)) {
            return -1;
        }
        (void)memcpy(e->did_val[i], c->dids[i].init, c->dids[i].len);
        (void)memcpy(e->io_val[i], c->dids[i].init, c->dids[i].len);
    }
    for (uint16_t i = 0; i < c->n_mem; i++) {
        e->mem[i] = malloc(c->mem[i].size);
        if (e->mem[i] == NULL) {
            return -1;
        }
        (void)memset(e->mem[i], c->mem[i].fill, c->mem[i].size);
        if (c->mem[i].init_len > 0U) {
            (void)memcpy(e->mem[i], c->mem[i].init, c->mem[i].init_len);
        }
    }
    for (uint16_t i = 0; i < c->n_dtcs; i++) {
        e->dtc[i].status = c->dtcs[i].status;
        e->dtc[i].stored = true;
    }
    e->crc_valid = false;
    e->xfer_region = -1;
    ecu_volatile_reset(e);
    return 0;
}

void ecu_state_free(ecu_t *e) {
    for (uint16_t i = 0; i < e->cfg.n_dids; i++) {
        if (e->did_val != NULL) {
            free(e->did_val[i]);
        }
        if (e->io_val != NULL) {
            free(e->io_val[i]);
        }
    }
    for (uint16_t i = 0; (e->mem != NULL) && (i < e->cfg.n_mem); i++) {
        free(e->mem[i]);
    }
    free(e->did_val);
    free(e->io_val);
    free(e->io_active);
    free(e->sec);
    free(e->rt);
    free(e->fault_hits);
    free(e->mem);
    free(e->dtc);
    e->did_val = NULL;
    e->io_val = NULL;
    e->io_active = NULL;
    e->sec = NULL;
    e->rt = NULL;
    e->fault_hits = NULL;
    e->mem = NULL;
    e->dtc = NULL;
}

/* state that does not survive an ECUReset */
void ecu_volatile_reset(ecu_t *e) {
    for (uint16_t i = 0; i < e->cfg.n_dids; i++) {
        e->io_active[i] = false;
    }
    (void)memset(e->sec, 0, (e->cfg.n_sec ? e->cfg.n_sec : 1U) * sizeof(sec_state_t));
    (void)memset(e->rt, 0, (e->cfg.n_routines ? e->cfg.n_routines : 1U) * sizeof(routine_state_t));
    e->comm_ctrl = 0;
    e->dtc_setting_on = true;
    e->xfer_region = -1;
    e->cur_fault = -1;
    e->pending_sent = 0;
    e->rdbi_calls = 0;
    e->drop_response = false;
    e->cur_functional = false;
    e->reset_pending = 0;
}

/* ISO 14229-1: security is re-locked on every session transition; leaving to the default
 * session also ends IO control, communication control and DTC-setting overrides. */
static void enter_session(ecu_t *e, uint8_t from, uint8_t to, const char *why) {
    e->srv->securityLevel = 0;
    for (uint16_t i = 0; i < e->cfg.n_sec; i++) {
        e->sec[i].seed_pending = false;
    }
    if (to == UDS_LEV_DS_DS) {
        for (uint16_t i = 0; i < e->cfg.n_dids; i++) {
            e->io_active[i] = false;
        }
        e->comm_ctrl = 0;
        e->dtc_setting_on = true;
    }
    log_event("\"ev\":\"session\",\"from\":%u,\"to\":%u,\"why\":\"%s\"", from, to, why);
}

/* ------------------------------------------------------------------ */
/* transport hooks                                                    */
/* ------------------------------------------------------------------ */

static bool sid_has_subfunction(uint8_t sid) {
    switch (sid) {
    case 0x10: case 0x11: case 0x27: case 0x28: case 0x31: case 0x3E: case 0x85: case 0x87:
        return true;
    default:
        return false;
    }
}

static bool fault_match(const fault_cfg_t *f, const uint8_t *b, size_t len) {
    if ((len < 1U) || (b[0] != f->sid)) {
        return false;
    }
    if (f->has_sub && ((len < 2U) || ((b[1] & 0x7FU) != f->sub))) {
        return false;
    }
    if (!f->has_id) {
        return true;
    }
    if (f->sid == 0x22U) { /* any of the requested DIDs */
        for (size_t i = 1; (i + 1U) < len; i += 2U) {
            if ((((uint16_t)b[i] << 8) | b[i + 1U]) == f->id) {
                return true;
            }
        }
        return false;
    }
    size_t at = (f->sid == 0x31U) ? 2U : 1U;
    return (len >= at + 2U) && ((((uint16_t)b[at] << 8) | b[at + 1U]) == f->id);
}

static const char *fault_kind_str(fault_kind_t k) {
    switch (k) {
    case FAULT_NRC: return "nrc";
    case FAULT_PENDING: return "pending";
    case FAULT_DELAY: return "delay";
    case FAULT_NO_RESPONSE: return "no_response";
    default: return "?";
    }
}

void ecu_on_rx(void *user, uint8_t *buf, size_t len, const UDSSDU_t *info) {
    ecu_t *e = user;
    UDSServer_t *srv = e->srv;
    uint32_t now = UDSMillis();
    char extra[64];

    (void)snprintf(extra, sizeof(extra), "\"ta\":\"%s\",\"session\":%u",
                   (info->A_TA_Type == UDS_A_TA_TYPE_FUNCTIONAL) ? "func" : "phys",
                   srv->sessionType);
    log_bytes("rx", extra, buf, len);

    e->cur_fault = -1;
    e->pending_sent = 0;
    e->rdbi_calls = 0;
    e->drop_response = false;
    e->cur_functional = (info->A_TA_Type == UDS_A_TA_TYPE_FUNCTIONAL);

    /* iso14229 0.11.0 Handle_0x38_RequestFileTransfer returns NRCs without building a negative
     * response (no NegativeResponse() call), so the *previous* response still in send_buf is
     * re-sent. ecusim does not support 0x38: pre-build the correct 7F 38 11 so that whatever
     * path the library takes, the frame on the bus is serviceNotSupported. */
    if ((len >= 1U) && (buf[0] == 0x38U)) {
        srv->r.send_buf[0] = 0x7FU;
        srv->r.send_buf[1] = 0x38U;
        srv->r.send_buf[2] = (uint8_t)UDS_NRC_ServiceNotSupported;
        srv->r.send_len = 3U;
    }

    /* iso14229 0.11.0 uses p2_timer as a *minimum* spacing between responses (a response is
     * held back until p2_ms after the previous one). A real ECU answers as soon as it can:
     * release the response immediately (plus the configured global response delay). */
    srv->p2_timer = (e->cfg.response_delay_ms == 0U) ? (now - 1U) : (now + e->cfg.response_delay_ms);

    /* ISO 14229-2: S3server restarts on every received request. iso14229 0.11.0 only does
     * this for 0x10 and 0x3E. */
    srv->s3_session_timeout_timer = now + srv->s3_ms;

    for (uint16_t i = 0; i < e->cfg.n_faults; i++) {
        const fault_cfg_t *f = &e->cfg.faults[i];
        if (!fault_match(f, buf, len)) {
            continue;
        }
        if ((f->count != 0U) && (e->fault_hits[i] >= f->count)) {
            continue;
        }
        e->fault_hits[i]++;
        e->cur_fault = (int)i;
        log_event("\"ev\":\"fault\",\"index\":%u,\"kind\":\"%s\",\"hit\":%u", i,
                  fault_kind_str(f->kind), e->fault_hits[i]);
        if (f->kind == FAULT_DELAY) {
            srv->p2_timer = now + f->delay_ms;
        } else if (f->kind == FAULT_NO_RESPONSE) {
            e->drop_response = true;
        } else if ((f->kind == FAULT_PENDING) && (len >= 2U) && sid_has_subfunction(buf[0]) &&
                   ((buf[1] & 0x80U) != 0U)) {
            /* ISO 14229-1 7.5: after NRC 0x78 the final positive response must be sent even
             * if suppressPosRspMsgIndicationBit is set. iso14229 0.11.0 does not track this
             * (TODO in evaluateServiceResponse) and would swallow the final response, so the
             * bit is cleared before the library sees the request. */
            buf[1] &= 0x7FU;
            log_event("\"ev\":\"spr_cleared_for_pending\"");
        }
        break;
    }
}

bool ecu_on_tx(void *user, const uint8_t *buf, size_t len) {
    ecu_t *e = user;
    e->srv->s3_session_timeout_timer = UDSMillis() + e->srv->s3_ms;
    if (e->drop_response) {
        log_bytes("tx_drop", "\"reason\":\"fault_no_response\"", buf, len);
        return false;
    }
    if ((len >= 3U) && (buf[0] == 0x7FU) && (buf[2] == 0x78U)) {
        e->pending_sent++;
    }
    /* ISO 14229-1 7.5 / Table 6: for functionally addressed requests the NRCs 0x11, 0x12, 0x31,
     * 0x7E and 0x7F are not sent (unless a 0x78 was sent before). iso14229 0.11.0 implements
     * this in evaluateServiceResponse(), but the UDS_EVT_Custom path (SIDs without a built-in
     * handler, e.g. OBD 0x01) and the "SID > 0xBF" path return early and bypass it. */
    if (e->cur_functional && (e->pending_sent == 0U) && (len == 3U) && (buf[0] == 0x7FU) &&
        ((buf[2] == 0x11U) || (buf[2] == 0x12U) || (buf[2] == 0x31U) || (buf[2] == 0x7EU) ||
         (buf[2] == 0x7FU))) {
        log_bytes("tx_suppressed", "\"reason\":\"functional_nrc\"", buf, len);
        return false;
    }
    log_bytes("tx", NULL, buf, len);
    return true;
}

/* ------------------------------------------------------------------ */
/* service handlers                                                   */
/* ------------------------------------------------------------------ */

static UDSErr_t h_session(ecu_t *e, UDSDiagSessCtrlArgs_t *a) {
    const session_cfg_t *s = find_session(e, a->type);
    if (s == NULL) {
        return UDS_NRC_SubFunctionNotSupported;
    }
    if (!sess_ok(&s->from, e->srv->sessionType)) {
        return UDS_NRC_ConditionsNotCorrect;
    }
    /* iso14229 0.11.0 pre-fills these with UDS_CLIENT_DEFAULT_* (client constants) */
    a->p2_ms = e->cfg.p2_ms;
    a->p2_star_ms = e->cfg.p2_star_ms;
    enter_session(e, e->srv->sessionType, a->type, "0x10");
    return NRC_OK;
}

static UDSErr_t h_reset(ecu_t *e, UDSECUResetArgs_t *a) {
    if ((a->type < 1U) || (a->type > 3U)) {
        return UDS_NRC_SubFunctionNotSupported;
    }
    a->powerDownTimeMillis = e->cfg.reset_power_down_ms;
    log_event("\"ev\":\"ecu_reset_scheduled\",\"type\":%u,\"power_down_ms\":%u", a->type,
              e->cfg.reset_power_down_ms);
    return NRC_OK;
}

static bool sec_locked_out(ecu_t *e, sec_state_t *st) {
    if (!st->lockout_active) {
        return false;
    }
    /* UDSTimeAfter() is private to iso14229.c; same wrap-safe comparison */
    if ((int32_t)(UDSMillis() - st->lockout_until) >= 0) {
        st->lockout_active = false;
        st->attempts = 0;
        log_event("\"ev\":\"security_lockout_end\"");
        return false;
    }
    (void)e;
    return true;
}

static UDSErr_t h_seed(ecu_t *e, UDSSecAccessRequestSeedArgs_t *a) {
    int i = find_sec(e, a->level);
    if (i < 0) {
        return UDS_NRC_SubFunctionNotSupported;
    }
    const sec_level_cfg_t *c = &e->cfg.sec[i];
    sec_state_t *st = &e->sec[i];
    if (!sess_ok(&c->sessions, e->srv->sessionType)) {
        return UDS_NRC_SubFunctionNotSupportedInActiveSession;
    }
    if (sec_locked_out(e, st)) {
        return UDS_NRC_RequiredTimeDelayNotExpired;
    }
    if (a->len != 0U) {
        return UDS_NRC_IncorrectMessageLengthOrInvalidFormat;
    }
    (void)memcpy(st->seed, c->seed, c->seed_len);
    if (c->seed_counter) { /* deterministic: seed + n (big endian) */
        uint32_t carry = st->seed_counter++;
        for (int k = (int)c->seed_len - 1; (k >= 0) && (carry != 0U); k--) {
            uint32_t s = (uint32_t)st->seed[k] + (carry & 0xFFU);
            st->seed[k] = (uint8_t)s;
            carry = (carry >> 8) + (s >> 8);
        }
    }
    st->seed_pending = true;
    return (UDSErr_t)a->copySeed(e->srv, st->seed, c->seed_len);
}

static UDSErr_t h_key(ecu_t *e, UDSSecAccessValidateKeyArgs_t *a) {
    int i = find_sec(e, a->level);
    if (i < 0) {
        return UDS_NRC_SubFunctionNotSupported;
    }
    const sec_level_cfg_t *c = &e->cfg.sec[i];
    sec_state_t *st = &e->sec[i];
    if (!sess_ok(&c->sessions, e->srv->sessionType)) {
        return UDS_NRC_SubFunctionNotSupportedInActiveSession;
    }
    if (sec_locked_out(e, st)) {
        return UDS_NRC_RequiredTimeDelayNotExpired;
    }
    if (!st->seed_pending) {
        return UDS_NRC_RequestSequenceError;
    }
    st->seed_pending = false;
    uint8_t key[32];
    for (uint8_t k = 0; k < c->seed_len; k++) {
        key[k] = (c->alg == SA_ALG_XOR_FF) ? (uint8_t)(st->seed[k] ^ 0xFFU)
                                           : (uint8_t)(st->seed[k] ^ c->konst[k % c->konst_len]);
    }
    if ((a->len == c->seed_len) && (memcmp(key, a->key, c->seed_len) == 0)) {
        st->attempts = 0;
        log_event("\"ev\":\"security_unlocked\",\"level\":%u", a->level);
        return NRC_OK;
    }
    st->attempts++;
    log_event("\"ev\":\"security_invalid_key\",\"level\":%u,\"attempts\":%u,\"max\":%u", a->level,
              st->attempts, c->max_attempts);
    if (st->attempts >= c->max_attempts) {
        st->lockout_active = true;
        st->lockout_until = UDSMillis() + c->lockout_ms;
        log_event("\"ev\":\"security_lockout\",\"level\":%u,\"ms\":%u", a->level, c->lockout_ms);
        return UDS_NRC_ExceedNumberOfAttempts;
    }
    return UDS_NRC_InvalidKey;
}

static UDSErr_t h_rdbi(ecu_t *e, UDSRDBIArgs_t *a) {
    UDSServer_t *srv = e->srv;
    uint16_t call = e->rdbi_calls++;
    uint16_t n_dids = (uint16_t)((srv->r.recv_len - 1U) / 2U);
    bool last = (uint16_t)(call + 1U) >= n_dids;
    int i = find_did(e, a->dataId);
    bool supported = (i >= 0) && e->cfg.dids[i].readable &&
                     sess_ok(&e->cfg.dids[i].read.sessions, srv->sessionType);

    if (!supported) {
        /* ISO 14229-1:2020 10.2.4: unsupported DIDs are omitted from a multi-DID response;
         * NRC 0x31 only if none is supported. iso14229 0.11.0 has already echoed the DID into
         * the response buffer — remove it again. */
        srv->r.send_len -= 2U;
        if (last && (srv->r.send_len <= 1U)) {
            return UDS_NRC_RequestOutOfRange;
        }
        return NRC_OK;
    }
    if (!sec_ok(e, e->cfg.dids[i].read.security)) {
        return UDS_NRC_SecurityAccessDenied;
    }
    return (UDSErr_t)a->copy(srv, did_current(e, i), e->cfg.dids[i].len);
}

static UDSErr_t h_wdbi(ecu_t *e, const UDSWDBIArgs_t *a) {
    int i = find_did(e, a->dataId);
    if ((i < 0) || !e->cfg.dids[i].writable || (e->cfg.dids[i].source != DID_SRC_STATIC) ||
        !sess_ok(&e->cfg.dids[i].write.sessions, e->srv->sessionType)) {
        return UDS_NRC_RequestOutOfRange;
    }
    if (!sec_ok(e, e->cfg.dids[i].write.security)) {
        return UDS_NRC_SecurityAccessDenied;
    }
    if (a->len != e->cfg.dids[i].len) {
        return UDS_NRC_IncorrectMessageLengthOrInvalidFormat;
    }
    (void)memcpy(e->did_val[i], a->data, a->len);
    log_event("\"ev\":\"did_written\",\"did\":%u", a->dataId);
    return NRC_OK;
}

static UDSErr_t h_ioctl(ecu_t *e, const UDSIOCtrlArgs_t *a) {
    int i = find_did(e, a->dataId);
    if ((i < 0) || !e->cfg.dids[i].io_control ||
        !sess_ok(&e->cfg.dids[i].io.sessions, e->srv->sessionType)) {
        return UDS_NRC_RequestOutOfRange;
    }
    if (!sec_ok(e, e->cfg.dids[i].io.security)) {
        return UDS_NRC_SecurityAccessDenied;
    }
    const did_cfg_t *d = &e->cfg.dids[i];
    switch (a->ioCtrlParam) {
    case 0x00: /* returnControlToECU */
    case 0x01: /* resetToDefault */
    case 0x02: /* freezeCurrentState */
        if (a->ctrlStateAndMaskLen != 0U) {
            return UDS_NRC_IncorrectMessageLengthOrInvalidFormat;
        }
        if (a->ioCtrlParam == 0x00U) {
            e->io_active[i] = false;
        } else if (a->ioCtrlParam == 0x01U) {
            (void)memcpy(e->io_val[i], d->init, d->len);
            e->io_active[i] = true;
        } else {
            (void)memmove(e->io_val[i], did_current(e, i), d->len);
            e->io_active[i] = true;
        }
        break;
    case 0x03: /* shortTermAdjustment (controlState only, no controlMask) */
        if (a->ctrlStateAndMaskLen != d->len) {
            return UDS_NRC_IncorrectMessageLengthOrInvalidFormat;
        }
        (void)memcpy(e->io_val[i], a->ctrlStateAndMask, d->len);
        e->io_active[i] = true;
        break;
    default:
        return UDS_NRC_RequestOutOfRange;
    }
    log_event("\"ev\":\"io_control\",\"did\":%u,\"param\":%u,\"active\":%s", a->dataId,
              a->ioCtrlParam, e->io_active[i] ? "true" : "false");
    return (UDSErr_t)a->copy(e->srv, did_current(e, i), d->len);
}

static UDSErr_t copy_opt(ecu_t *e, UDSRoutineCtrlArgs_t *a, const uint8_t *p, uint16_t n) {
    return (n == 0U) ? NRC_OK : (UDSErr_t)a->copyStatusRecord(e->srv, p, n);
}

static UDSErr_t h_routine(ecu_t *e, UDSRoutineCtrlArgs_t *a) {
    int i = find_routine(e, a->id);
    if ((i < 0) || !sess_ok(&e->cfg.routines[i].access.sessions, e->srv->sessionType)) {
        return UDS_NRC_RequestOutOfRange;
    }
    const routine_cfg_t *r = &e->cfg.routines[i];
    routine_state_t *st = &e->rt[i];
    if (!sec_ok(e, r->access.security)) {
        return UDS_NRC_SecurityAccessDenied;
    }
    uint8_t crc[4];
    switch (a->ctrlType) {
    case UDS_LEV_RCTP_STR:
        if (r->action == RT_CRC32) {
            if (!e->crc_valid) {
                return UDS_NRC_RequestSequenceError;
            }
            put_be32(crc, e->crc);
            st->started = true;
            log_event("\"ev\":\"routine\",\"rid\":%u,\"op\":\"start\",\"crc32\":\"%08X\"", a->id,
                      e->crc);
            return copy_opt(e, a, crc, 4);
        }
        if (r->action == RT_ERASE) {
            for (uint16_t k = 0; k < e->cfg.n_mem; k++) {
                if (e->cfg.mem[k].downloadable) {
                    (void)memset(e->mem[k], e->cfg.mem[k].fill, e->cfg.mem[k].size);
                }
            }
            e->crc_valid = false;
        }
        st->started = true;
        st->running = true;
        log_event("\"ev\":\"routine\",\"rid\":%u,\"op\":\"start\"", a->id);
        return copy_opt(e, a, r->start_result, r->start_result_len);
    case UDS_LEV_RCTP_STPR:
        if (!st->running) {
            return UDS_NRC_RequestSequenceError;
        }
        st->running = false;
        log_event("\"ev\":\"routine\",\"rid\":%u,\"op\":\"stop\"", a->id);
        return copy_opt(e, a, r->stop_result, r->stop_result_len);
    case UDS_LEV_RCTP_RRR:
        if (!st->started) {
            return UDS_NRC_RequestSequenceError;
        }
        if (r->action == RT_CRC32) {
            put_be32(crc, e->crc);
            return copy_opt(e, a, crc, 4);
        }
        return copy_opt(e, a, r->results, r->results_len);
    default:
        return UDS_NRC_SubFunctionNotSupported;
    }
}

static UDSErr_t h_download(ecu_t *e, UDSRequestDownloadArgs_t *a) {
    if (a->dataFormatIdentifier != 0x00U) {
        return UDS_NRC_RequestOutOfRange;
    }
    int r = find_region(e, (uint64_t)a->addr, (uint64_t)a->size, true);
    if (r < 0) {
        return UDS_NRC_RequestOutOfRange;
    }
    e->xfer_region = r;
    e->xfer_addr = (uint32_t)a->addr;
    e->crc_valid = false;
    a->maxNumberOfBlockLength = e->cfg.max_block_length;
    log_event("\"ev\":\"download_start\",\"region\":\"%s\",\"addr\":%u,\"size\":%zu,"
              "\"max_block_length\":%u",
              e->cfg.mem[r].name, e->xfer_addr, a->size, e->cfg.max_block_length);
    return NRC_OK;
}

static UDSErr_t h_transfer(ecu_t *e, const UDSTransferDataArgs_t *a) {
    if (e->xfer_region < 0) {
        return UDS_NRC_RequestSequenceError;
    }
    if ((a->len == 0U) || (((uint32_t)a->len + 2U) > e->cfg.max_block_length)) {
        return UDS_NRC_IncorrectMessageLengthOrInvalidFormat;
    }
    const mem_region_cfg_t *r = &e->cfg.mem[e->xfer_region];
    size_t off = (size_t)(e->xfer_addr - r->addr) + e->srv->xferByteCounter;
    if ((off + a->len) > r->size) { /* cannot happen: library bounds by xferTotalBytes */
        return UDS_NRC_TransferDataSuspended;
    }
    (void)memcpy(&e->mem[e->xfer_region][off], a->data, a->len);
    return NRC_OK;
}

static UDSErr_t h_transfer_exit(ecu_t *e) {
    UDSServer_t *srv = e->srv;
    if (e->xfer_region < 0) {
        return UDS_NRC_RequestSequenceError;
    }
    if (srv->xferByteCounter != srv->xferTotalBytes) {
        log_event("\"ev\":\"download_incomplete\",\"got\":%zu,\"want\":%zu", srv->xferByteCounter,
                  srv->xferTotalBytes);
        return UDS_NRC_RequestSequenceError;
    }
    const mem_region_cfg_t *r = &e->cfg.mem[e->xfer_region];
    size_t off = (size_t)(e->xfer_addr - r->addr);
    e->crc = crc32_ieee(&e->mem[e->xfer_region][off], srv->xferTotalBytes);
    e->crc_valid = true;
    e->crc_addr = e->xfer_addr;
    e->crc_size = (uint32_t)srv->xferTotalBytes;
    log_event("\"ev\":\"download_done\",\"addr\":%u,\"size\":%u,\"crc32\":\"%08X\"", e->crc_addr,
              e->crc_size, e->crc);
    e->xfer_region = -1;
    return NRC_OK;
}

static UDSErr_t h_rmba(ecu_t *e, const UDSReadMemByAddrArgs_t *a) {
    int r = find_region(e, (uint64_t)a->memAddr, (uint64_t)a->memSize, false);
    if ((r < 0) || (a->memSize > 0xFFFFU)) {
        return UDS_NRC_RequestOutOfRange;
    }
    size_t off = (size_t)(a->memAddr - e->cfg.mem[r].addr);
    return (UDSErr_t)a->copy(e->srv, &e->mem[r][off], (uint16_t)a->memSize);
}

static UDSErr_t dtc_header(ecu_t *e, UDSRDTCIArgs_t *a, uint16_t i) {
    uint8_t h[4];
    h[0] = (uint8_t)(e->cfg.dtcs[i].dtc >> 16);
    h[1] = (uint8_t)(e->cfg.dtcs[i].dtc >> 8);
    h[2] = (uint8_t)e->cfg.dtcs[i].dtc;
    h[3] = (uint8_t)(e->dtc[i].status & e->cfg.dtc_availability_mask);
    return (UDSErr_t)a->copy(e->srv, h, 4);
}

static int find_dtc(const ecu_t *e, uint32_t dtc) {
    for (uint16_t i = 0; i < e->cfg.n_dtcs; i++) {
        if (e->cfg.dtcs[i].dtc == dtc) {
            return (int)i;
        }
    }
    return -1;
}

static UDSErr_t dtc_records(ecu_t *e, UDSRDTCIArgs_t *a, uint32_t dtc, uint8_t rec, bool snapshot) {
    int i = find_dtc(e, dtc);
    if (i < 0) {
        return UDS_NRC_RequestOutOfRange;
    }
    const dtc_cfg_t *c = &e->cfg.dtcs[i];
    const dtc_record_cfg_t *rs = snapshot ? c->snapshots : c->ext;
    uint16_t n = snapshot ? c->n_snapshots : c->n_ext;
    bool all = (rec == 0xFFU) || (!snapshot && (rec == 0xFEU));
    bool known = all;
    for (uint16_t k = 0; k < n; k++) {
        known = known || (rs[k].record == rec);
    }
    if (!known) {
        return UDS_NRC_RequestOutOfRange;
    }
    UDSErr_t err = dtc_header(e, a, (uint16_t)i);
    if (err != NRC_OK) {
        return err;
    }
    if (!e->dtc[i].stored) { /* cleared by 0x14: DTCAndStatusRecord only */
        return NRC_OK;
    }
    for (uint16_t k = 0; k < n; k++) {
        if (!all && (rs[k].record != rec)) {
            continue;
        }
        err = (UDSErr_t)a->copy(e->srv, &rs[k].record, 1);
        if (err == NRC_OK) {
            err = (UDSErr_t)a->copy(e->srv, rs[k].data, rs[k].len);
        }
        if (err != NRC_OK) {
            return err;
        }
    }
    return NRC_OK;
}

static UDSErr_t h_rdtci(ecu_t *e, UDSRDTCIArgs_t *a) {
    uint8_t avail = e->cfg.dtc_availability_mask;
    UDSErr_t err = NRC_OK;
    switch (a->type) {
    case 0x01: { /* reportNumberOfDTCByStatusMask */
        uint8_t mask = a->subFuncArgs.numOfDTCByStatusMaskArgs.mask;
        uint16_t cnt = 0;
        for (uint16_t i = 0; i < e->cfg.n_dtcs; i++) {
            cnt = (uint16_t)(cnt + (((e->dtc[i].status & avail & mask) != 0U) ? 1U : 0U));
        }
        uint8_t out[4] = {avail, 0x01 /* ISO_14229-1_DTCFormat */, (uint8_t)(cnt >> 8),
                          (uint8_t)cnt};
        return (UDSErr_t)a->copy(e->srv, out, 4);
    }
    case 0x02:   /* reportDTCByStatusMask */
    case 0x0A: { /* reportSupportedDTC */
        uint8_t mask = (a->type == 0x02U) ? a->subFuncArgs.dtcStatusByMaskArgs.mask : 0U;
        err = (UDSErr_t)a->copy(e->srv, &avail, 1);
        for (uint16_t i = 0; (err == NRC_OK) && (i < e->cfg.n_dtcs); i++) {
            if ((a->type == 0x0AU) || ((e->dtc[i].status & avail & mask) != 0U)) {
                err = dtc_header(e, a, i);
            }
        }
        return err;
    }
    case 0x04:
        return dtc_records(e, a, a->subFuncArgs.dtcSnapshotRecordbyDTCNumArgs.dtc,
                           a->subFuncArgs.dtcSnapshotRecordbyDTCNumArgs.snapshotNum, true);
    case 0x06:
        return dtc_records(e, a, a->subFuncArgs.dtcExtDtaRecordByDTCNumArgs.dtc,
                           a->subFuncArgs.dtcExtDtaRecordByDTCNumArgs.extDataRecNum, false);
    default:
        return UDS_NRC_SubFunctionNotSupported;
    }
}

static UDSErr_t h_clear_dtc(ecu_t *e, const UDSCDIArgs_t *a) {
    if (a->hasMemorySelection) {
        return UDS_NRC_RequestOutOfRange;
    }
    int only = -1;
    if (a->groupOfDTC != 0xFFFFFFU) {
        only = find_dtc(e, a->groupOfDTC);
        if (only < 0) {
            return UDS_NRC_RequestOutOfRange;
        }
    }
    uint16_t cleared = 0;
    for (uint16_t i = 0; i < e->cfg.n_dtcs; i++) {
        if ((only < 0) || (only == (int)i)) {
            e->dtc[i].status = 0x00;
            e->dtc[i].stored = false;
            cleared++;
        }
    }
    log_event("\"ev\":\"dtc_cleared\",\"group\":%u,\"count\":%u", a->groupOfDTC, cleared);
    return NRC_OK;
}

static bool obd_configured(const ecu_t *e, uint8_t pid, const obd_pid_cfg_t **out) {
    for (uint16_t i = 0; i < e->cfg.n_obd; i++) {
        if (e->cfg.obd[i].pid == pid) {
            if (out != NULL) {
                *out = &e->cfg.obd[i];
            }
            return true;
        }
    }
    return false;
}

static bool obd_support_pid_supported(const ecu_t *e, uint8_t base) {
    if (base == 0U) {
        return true;
    }
    for (uint16_t i = 0; i < e->cfg.n_obd; i++) {
        if (e->cfg.obd[i].pid > base) {
            return true;
        }
    }
    return false;
}

static UDSErr_t h_obd_mode01(ecu_t *e, const UDSCustomArgs_t *a) {
    if ((a->len < 1U) || (a->len > 6U)) {
        return UDS_NRC_IncorrectMessageLengthOrInvalidFormat;
    }
    uint8_t out[6U * 9U];
    uint16_t pos = 0;
    for (uint16_t k = 0; k < a->len; k++) {
        uint8_t pid = a->optionRecord[k];
        const obd_pid_cfg_t *p = NULL;
        if ((pid % 0x20U) == 0U) {
            if (!obd_support_pid_supported(e, pid)) {
                continue;
            }
            uint32_t bm = 0;
            for (uint32_t b = 1; b <= 0x20U; b++) {
                uint32_t q = (uint32_t)pid + b;
                bool sup = (b == 0x20U) ? ((q <= 0xFFU) && obd_support_pid_supported(e, (uint8_t)q))
                                        : ((q <= 0xFFU) && obd_configured(e, (uint8_t)q, NULL));
                if (sup) {
                    bm |= 1UL << (32U - b);
                }
            }
            out[pos++] = pid;
            put_be32(&out[pos], bm);
            pos = (uint16_t)(pos + 4U);
        } else if (obd_configured(e, pid, &p)) {
            out[pos++] = pid;
            (void)memcpy(&out[pos], p->data, p->len);
            pos = (uint16_t)(pos + p->len);
        }
    }
    if (pos == 0U) {
        return UDS_NRC_RequestOutOfRange; /* suppressed by iso14229 for functional requests */
    }
    return (UDSErr_t)a->copyResponse(e->srv, out, pos);
}

/* ------------------------------------------------------------------ */
/* event entry point                                                  */
/* ------------------------------------------------------------------ */

UDSErr_t ecu_event(UDSServer_t *srv, UDSEvent_t ev, void *arg) {
    ecu_t *e = srv->fn_data;

    switch (ev) {
    case UDS_EVT_Err:
        log_event("\"ev\":\"uds_err\",\"err\":%d", (arg != NULL) ? (int)*(UDSErr_t *)arg : -1);
        return NRC_OK;
    case UDS_EVT_SessionTimeout:
        log_event("\"ev\":\"s3_timeout\",\"session\":%u", srv->sessionType);
        enter_session(e, srv->sessionType, UDS_LEV_DS_DS, "s3_timeout");
        return NRC_OK;
    case UDS_EVT_DoScheduledReset:
        e->reset_pending = (arg != NULL) ? *(uint8_t *)arg : 1U;
        return NRC_OK;
    default:
        break;
    }

    /* request events from here on */
    uint8_t sid = srv->r.recv_buf[0];

    if (e->cur_fault >= 0) {
        const fault_cfg_t *f = &e->cfg.faults[e->cur_fault];
        if (f->kind == FAULT_NRC) {
            return (UDSErr_t)f->nrc;
        }
        if ((f->kind == FAULT_PENDING) && (e->pending_sent < f->pending)) {
            e->rdbi_calls = 0; /* evaluation aborted; restarts later */
            return UDS_NRC_RequestCorrectlyReceived_ResponsePending;
        }
    }

    const service_cfg_t *svc = find_service(e, sid);
    if (svc != NULL) {
        if (!svc->enabled) {
            return UDS_NRC_ServiceNotSupported;
        }
        if (!sess_ok(&svc->access.sessions, srv->sessionType)) {
            return UDS_NRC_ServiceNotSupportedInActiveSession;
        }
        if (!sec_ok(e, svc->access.security)) {
            return UDS_NRC_SecurityAccessDenied;
        }
    }

    switch (ev) {
    case UDS_EVT_DiagSessCtrl:
        return h_session(e, arg);
    case UDS_EVT_EcuReset:
        return h_reset(e, arg);
    case UDS_EVT_ClearDiagnosticInfo:
        return h_clear_dtc(e, arg);
    case UDS_EVT_ReadDTCInformation:
        return h_rdtci(e, arg);
    case UDS_EVT_ReadDataByIdent:
        return h_rdbi(e, arg);
    case UDS_EVT_ReadMemByAddr:
        return h_rmba(e, arg);
    case UDS_EVT_CommCtrl: {
        UDSCommCtrlArgs_t *a = arg;
        if (a->ctrlType > 0x03U) {
            return UDS_NRC_SubFunctionNotSupported;
        }
        if ((a->commType & 0x03U) == 0U) {
            return UDS_NRC_RequestOutOfRange;
        }
        e->comm_ctrl = a->ctrlType;
        log_event("\"ev\":\"comm_ctrl\",\"ctrl\":%u,\"comm\":%u", a->ctrlType, a->commType);
        return NRC_OK;
    }
    case UDS_EVT_SecAccessRequestSeed:
        return h_seed(e, arg);
    case UDS_EVT_SecAccessValidateKey:
        return h_key(e, arg);
    case UDS_EVT_WriteDataByIdent:
        return h_wdbi(e, arg);
    case UDS_EVT_IOControl:
        return h_ioctl(e, arg);
    case UDS_EVT_RoutineCtrl:
        return h_routine(e, arg);
    case UDS_EVT_RequestDownload:
        return h_download(e, arg);
    case UDS_EVT_TransferData:
        return h_transfer(e, arg);
    case UDS_EVT_RequestTransferExit:
        return h_transfer_exit(e);
    case UDS_EVT_ControlDTCSetting: {
        const UDSControlDTCSettingArgs_t *a = arg;
        if ((a->type != 0x01U) && (a->type != 0x02U)) {
            return UDS_NRC_SubFunctionNotSupported;
        }
        e->dtc_setting_on = (a->type == 0x01U);
        log_event("\"ev\":\"dtc_setting\",\"on\":%s", e->dtc_setting_on ? "true" : "false");
        return NRC_OK;
    }
    case UDS_EVT_Custom: {
        const UDSCustomArgs_t *a = arg;
        if ((a->sid == 0x01U) && (e->cfg.n_obd > 0U)) {
            return h_obd_mode01(e, a);
        }
        return UDS_NRC_ServiceNotSupported;
    }
    case UDS_EVT_WriteMemByAddr:
    case UDS_EVT_DynamicDefineDataId:
    case UDS_EVT_RequestUpload:
    case UDS_EVT_RequestFileTransfer:
    case UDS_EVT_LinkControl:
    default:
        return UDS_NRC_ServiceNotSupported;
    }
}
