/*
 * ecusim — test-only virtual UDS ECU for NexusCAN HIL verification.
 *
 * Built on driftregion/iso14229 (vendored, unmodified) + Linux kernel ISO-TP sockets.
 * This program is NOT part of the NexusCAN product and shares no code with it.
 */
#ifndef ECUSIM_H
#define ECUSIM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iso14229.h"

#define ECUSIM_MAX_SESSIONS_LIST 16U

/* ------------------------------------------------------------------ */
/* Configuration model (filled from JSON, see config.c / README.md)    */
/* ------------------------------------------------------------------ */

typedef struct {
    uint8_t n;                               /* 0 => any session allowed */
    uint8_t v[ECUSIM_MAX_SESSIONS_LIST];
} sess_list_t;

typedef struct {
    sess_list_t sessions;
    uint8_t security; /* 0 => no security; otherwise required (odd) seed level */
} access_t;

typedef struct {
    uint8_t id;
    sess_list_t from; /* allowed source sessions; empty => any */
} session_cfg_t;

typedef struct {
    uint8_t sid;
    bool enabled;
    access_t access;
} service_cfg_t;

typedef enum { DID_SRC_STATIC = 0, DID_SRC_ACTIVE_SESSION } did_source_t;

typedef struct {
    uint16_t id;
    uint8_t *init; /* initial value (owned) */
    uint16_t len;
    did_source_t source;
    bool readable;
    bool writable;
    bool io_control;
    access_t read;
    access_t write;
    access_t io;
} did_cfg_t;

typedef enum { SA_ALG_XOR_FF = 0, SA_ALG_XOR_CONST } sa_alg_t;

typedef struct {
    uint8_t level; /* odd requestSeed sub-function */
    uint8_t seed[32];
    uint8_t seed_len;
    bool seed_counter; /* true: deterministic incrementing seed; false: fixed seed */
    sa_alg_t alg;
    uint8_t konst[32];
    uint8_t konst_len;
    sess_list_t sessions; /* sessions in which this level may be requested */
    uint8_t max_attempts;
    uint32_t lockout_ms;
} sec_level_cfg_t;

typedef enum { RT_STATIC = 0, RT_CRC32, RT_ERASE } routine_action_t;

typedef struct {
    uint16_t id;
    routine_action_t action;
    access_t access;
    uint8_t *start_result;
    uint16_t start_result_len;
    uint8_t *stop_result;
    uint16_t stop_result_len;
    uint8_t *results;
    uint16_t results_len;
} routine_cfg_t;

typedef struct {
    char name[32];
    uint32_t addr;
    uint32_t size;
    uint8_t fill;
    uint8_t *init; /* optional initial content at offset 0 */
    uint32_t init_len;
    bool readable;     /* 0x23 */
    bool downloadable; /* 0x34/0x36/0x37 */
} mem_region_cfg_t;

typedef struct {
    uint8_t record;
    uint8_t *data; /* already in wire format: [numIds][DID hi][DID lo][data...]... */
    uint16_t len;
} dtc_record_cfg_t;

typedef struct {
    uint32_t dtc; /* 24 bit */
    uint8_t status;
    dtc_record_cfg_t *snapshots;
    uint16_t n_snapshots;
    dtc_record_cfg_t *ext;
    uint16_t n_ext;
} dtc_cfg_t;

typedef enum { FAULT_NRC = 0, FAULT_PENDING, FAULT_DELAY, FAULT_NO_RESPONSE } fault_kind_t;

typedef struct {
    uint8_t sid;
    bool has_id;
    uint16_t id; /* DID (0x22/0x2E/0x2F) or RID (0x31) */
    bool has_sub;
    uint8_t sub; /* sub-function (masked with 0x7F) */
    fault_kind_t kind;
    uint8_t nrc;
    uint16_t pending; /* number of 0x78 frames before the real response */
    uint32_t delay_ms;
    uint32_t count; /* apply to the first N matching requests; 0 => always */
} fault_cfg_t;

typedef struct {
    uint8_t pid;
    uint8_t data[8];
    uint8_t len;
} obd_pid_cfg_t;

typedef struct {
    /* timing */
    uint16_t p2_ms;
    uint32_t p2_star_ms;
    uint16_t s3_ms;
    uint32_t security_boot_delay_ms;
    uint32_t reset_power_down_ms;
    uint32_t response_delay_ms;

    /* iso-tp */
    uint8_t isotp_bs;
    uint8_t isotp_stmin;
    int tx_padding; /* -1 => none */

    session_cfg_t *sessions;
    uint16_t n_sessions;
    service_cfg_t *services;
    uint16_t n_services;
    did_cfg_t *dids;
    uint16_t n_dids;
    sec_level_cfg_t *sec;
    uint16_t n_sec;
    routine_cfg_t *routines;
    uint16_t n_routines;
    mem_region_cfg_t *mem;
    uint16_t n_mem;
    uint16_t max_block_length;
    dtc_cfg_t *dtcs;
    uint16_t n_dtcs;
    uint8_t dtc_availability_mask;
    obd_pid_cfg_t *obd;
    uint16_t n_obd;
    fault_cfg_t *faults;
    uint16_t n_faults;
} ecu_cfg_t;

int cfg_load(const char *path, ecu_cfg_t *out, char *err, size_t errlen);
void cfg_free(ecu_cfg_t *cfg);

/* ------------------------------------------------------------------ */
/* Runtime state                                                      */
/* ------------------------------------------------------------------ */

typedef struct {
    uint8_t attempts;
    uint32_t lockout_until; /* UDSMillis() */
    bool lockout_active;
    bool seed_pending;
    uint8_t seed[32];
    uint32_t seed_counter;
} sec_state_t;

typedef struct {
    bool started;
    bool running;
} routine_state_t;

typedef struct {
    uint8_t status;
    bool stored; /* snapshot / ext-data present (cleared by 0x14) */
} dtc_state_t;

typedef struct ecu {
    ecu_cfg_t cfg;

    /* volatile state (reset by ECUReset / SIGUSR1 / SIGHUP) */
    uint8_t **did_val;   /* per DID current value (0x2E writes; survives ECUReset) */
    uint8_t **io_val;    /* per DID 0x2F override value */
    bool *io_active;     /* per DID: 0x2F override active (volatile) */
    sec_state_t *sec;    /* per level */
    routine_state_t *rt; /* per routine */
    uint8_t comm_ctrl;   /* last 0x28 control type */
    bool dtc_setting_on;
    uint32_t *fault_hits;

    /* non-volatile state (survives ECUReset, reset by SIGUSR1 / SIGHUP) */
    uint8_t **mem;      /* per region buffer */
    dtc_state_t *dtc;   /* per DTC */
    bool crc_valid;
    uint32_t crc;
    uint32_t crc_addr;
    uint32_t crc_size;

    /* transfer bookkeeping */
    int xfer_region;
    uint32_t xfer_addr;

    /* per request bookkeeping */
    int cur_fault;          /* index of fault matched for the current request, -1 none */
    uint16_t pending_sent;  /* number of 0x78 frames sent for the current request */
    uint16_t rdbi_calls;    /* index of DID within the current RDBI evaluation */
    bool drop_response;
    bool cur_functional;    /* current request arrived on the functional id */

    /* deferred actions for main loop */
    uint8_t reset_pending; /* ECUReset type, 0 none */

    UDSServer_t *srv;
} ecu_t;

int ecu_state_init(ecu_t *e);           /* allocates state from e->cfg (all state) */
void ecu_state_free(ecu_t *e);
void ecu_volatile_reset(ecu_t *e);      /* sessions/security/io/fault counters */
UDSErr_t ecu_event(UDSServer_t *srv, UDSEvent_t ev, void *arg);

/* transport hooks (called by tp.c) */
void ecu_on_rx(void *user, uint8_t *buf, size_t len, const UDSSDU_t *info);
bool ecu_on_tx(void *user, const uint8_t *buf, size_t len);

/* ------------------------------------------------------------------ */
/* Transport: Linux kernel ISO-TP sockets                             */
/* ------------------------------------------------------------------ */

typedef struct {
    UDSTp_t hdl; /* must be first */
    int phys_fd;
    int func_fd;
    uint32_t phys_rx;
    uint32_t phys_tx;
    uint32_t func_rx;
    void *user;
    void (*on_rx)(void *user, uint8_t *buf, size_t len, const UDSSDU_t *info);
    bool (*on_tx)(void *user, const uint8_t *buf, size_t len);
} ecusim_tp_t;

typedef struct {
    const char *ifname;
    uint32_t phys_rx;
    uint32_t phys_tx;
    uint32_t func_rx;
    bool fd;
    uint8_t bs;
    uint8_t stmin;
    int tx_padding;
} ecusim_tp_opts_t;

int ecusim_tp_open(ecusim_tp_t *tp, const ecusim_tp_opts_t *o);
void ecusim_tp_close(ecusim_tp_t *tp);
size_t ecusim_tp_drain(ecusim_tp_t *tp); /* discard queued requests, returns count */

/* ------------------------------------------------------------------ */
/* JSON line log                                                      */
/* ------------------------------------------------------------------ */

int log_open(const char *path); /* NULL or "-" => stdout */
void log_close(void);
/* fmt is the JSON object body WITHOUT braces and without the timestamp, e.g. "\"ev\":\"x\"" */
void log_event(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
/* convenience: logs {"t":..,"ev":ev,<extra>,"data":"hex"} */
void log_bytes(const char *ev, const char *extra, const uint8_t *buf, size_t len);
double log_now_ms(void);

uint32_t crc32_ieee(const uint8_t *buf, size_t len);

#endif /* ECUSIM_H */
