/* JSON configuration loader (strict: unknown keys are rejected). Format: see README.md. */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "ecusim.h"

typedef struct {
    char *buf;
    size_t len;
} errbuf_t;

static int fail(errbuf_t *e, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static int fail(errbuf_t *e, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    (void)vsnprintf(e->buf, e->len, fmt, ap);
    va_end(ap);
    return -1;
}

static int check_keys(const cJSON *obj, const char *const *allowed, const char *where, errbuf_t *e) {
    if (!cJSON_IsObject(obj)) {
        return fail(e, "%s: expected object", where);
    }
    for (const cJSON *it = obj->child; it != NULL; it = it->next) {
        bool ok = false;
        for (size_t i = 0; allowed[i] != NULL; i++) {
            if (strcmp(it->string, allowed[i]) == 0) {
                ok = true;
                break;
            }
        }
        if (!ok && (it->string[0] != '_')) { /* keys starting with '_' are comments */
            return fail(e, "%s: unknown key \"%s\"", where, it->string);
        }
    }
    return 0;
}

/* number or string ("0x1A", "26") */
static int parse_u32_item(const cJSON *it, uint32_t max, uint32_t *out, const char *what,
                          errbuf_t *e) {
    if (cJSON_IsNumber(it)) {
        double d = it->valuedouble;
        if ((d < 0.0) || (d > (double)max) || (d != (double)(uint32_t)d)) {
            return fail(e, "%s: value out of range", what);
        }
        *out = (uint32_t)d;
        return 0;
    }
    if (cJSON_IsString(it)) {
        char *end = NULL;
        errno = 0;
        unsigned long v = strtoul(it->valuestring, &end, 0);
        if ((errno != 0) || (end == it->valuestring) || (*end != '\0') || (v > max)) {
            return fail(e, "%s: invalid number \"%s\"", what, it->valuestring);
        }
        *out = (uint32_t)v;
        return 0;
    }
    return fail(e, "%s: expected number or numeric string", what);
}

static int opt_u32(const cJSON *obj, const char *key, uint32_t max, uint32_t def, uint32_t *out,
                   errbuf_t *e) {
    const cJSON *it = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (it == NULL) {
        *out = def;
        return 0;
    }
    return parse_u32_item(it, max, out, key, e);
}

static int req_u32(const cJSON *obj, const char *key, uint32_t max, uint32_t *out, const char *where,
                   errbuf_t *e) {
    const cJSON *it = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (it == NULL) {
        return fail(e, "%s: missing \"%s\"", where, key);
    }
    return parse_u32_item(it, max, out, key, e);
}

static bool opt_bool(const cJSON *obj, const char *key, bool def) {
    const cJSON *it = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (it == NULL) {
        return def;
    }
    return cJSON_IsTrue(it);
}

static int hexval(int c) {
    if ((c >= '0') && (c <= '9')) {
        return c - '0';
    }
    c = tolower(c);
    if ((c >= 'a') && (c <= 'f')) {
        return 10 + (c - 'a');
    }
    return -1;
}

/* hex string, whitespace and ':' ignored. returns malloc'd buffer (may be NULL when len 0) */
static int parse_hex(const char *s, uint8_t **out, uint32_t *outlen, const char *what, errbuf_t *e) {
    size_t n = strlen(s);
    uint8_t *b = malloc((n / 2U) + 1U);
    if (b == NULL) {
        return fail(e, "out of memory");
    }
    uint32_t k = 0;
    int hi = -1;
    for (size_t i = 0; i < n; i++) {
        if (isspace((unsigned char)s[i]) || (s[i] == ':')) {
            continue;
        }
        int v = hexval((unsigned char)s[i]);
        if (v < 0) {
            free(b);
            return fail(e, "%s: invalid hex \"%s\"", what, s);
        }
        if (hi < 0) {
            hi = v;
        } else {
            b[k++] = (uint8_t)((hi << 4) | v);
            hi = -1;
        }
    }
    if (hi >= 0) {
        free(b);
        return fail(e, "%s: odd number of hex digits", what);
    }
    *out = b;
    *outlen = k;
    return 0;
}

static int opt_hex(const cJSON *obj, const char *key, uint8_t **out, uint16_t *outlen, errbuf_t *e) {
    const cJSON *it = cJSON_GetObjectItemCaseSensitive(obj, key);
    *out = NULL;
    *outlen = 0;
    if (it == NULL) {
        return 0;
    }
    if (!cJSON_IsString(it)) {
        return fail(e, "%s: expected hex string", key);
    }
    uint32_t l = 0;
    if (parse_hex(it->valuestring, out, &l, key, e) != 0) {
        return -1;
    }
    if (l > 0xFFFFU) {
        return fail(e, "%s: too long", key);
    }
    *outlen = (uint16_t)l;
    return 0;
}

static int hex_fixed(const cJSON *obj, const char *key, uint8_t *dst, uint8_t cap, uint8_t *len,
                     errbuf_t *e) {
    uint8_t *tmp = NULL;
    uint16_t l = 0;
    if (opt_hex(obj, key, &tmp, &l, e) != 0) {
        return -1;
    }
    if (l > cap) {
        free(tmp);
        return fail(e, "%s: longer than %u bytes", key, cap);
    }
    if (l > 0U) {
        (void)memcpy(dst, tmp, l);
    }
    *len = (uint8_t)l;
    free(tmp);
    return 0;
}

static int parse_sessions(const cJSON *obj, const char *key, sess_list_t *out, errbuf_t *e) {
    (void)memset(out, 0, sizeof(*out));
    const cJSON *arr = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (arr == NULL) {
        return 0;
    }
    if (!cJSON_IsArray(arr)) {
        return fail(e, "%s: expected array of session ids", key);
    }
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        uint32_t v = 0;
        if (out->n >= ECUSIM_MAX_SESSIONS_LIST) {
            return fail(e, "%s: too many entries", key);
        }
        if (parse_u32_item(it, 0x7F, &v, key, e) != 0) {
            return -1;
        }
        out->v[out->n++] = (uint8_t)v;
    }
    return 0;
}

static int parse_access(const cJSON *obj, const char *sess_key, const char *sec_key, access_t *a,
                        errbuf_t *e) {
    uint32_t sec = 0;
    if (parse_sessions(obj, sess_key, &a->sessions, e) != 0) {
        return -1;
    }
    if (opt_u32(obj, sec_key, 0x7F, 0, &sec, e) != 0) {
        return -1;
    }
    if ((sec != 0U) && ((sec % 2U) == 0U)) {
        return fail(e, "%s: security level must be the odd requestSeed value", sec_key);
    }
    a->security = (uint8_t)sec;
    return 0;
}

static int arr_items(const cJSON *root, const char *key, const cJSON **arr, uint16_t *n,
                     errbuf_t *e) {
    *arr = cJSON_GetObjectItemCaseSensitive(root, key);
    *n = 0;
    if (*arr == NULL) {
        return 0;
    }
    if (!cJSON_IsArray(*arr)) {
        return fail(e, "%s: expected array", key);
    }
    int sz = cJSON_GetArraySize(*arr);
    if (sz > 4096) {
        return fail(e, "%s: too many entries", key);
    }
    *n = (uint16_t)sz;
    return 0;
}

static int parse_timing(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"p2_ms",
                                       "p2_star_ms",
                                       "s3_ms",
                                       "security_boot_delay_ms",
                                       "reset_power_down_ms",
                                       "response_delay_ms",
                                       NULL};
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(root, "timing");
    uint32_t v = 0;
    cJSON empty = {0};
    empty.type = cJSON_Object;
    if (t == NULL) {
        t = &empty;
    }
    if (check_keys(t, keys, "timing", e) != 0) {
        return -1;
    }
    if (opt_u32(t, "p2_ms", 0xFFFF, 50, &v, e) != 0) {
        return -1;
    }
    c->p2_ms = (uint16_t)v;
    if (opt_u32(t, "p2_star_ms", 655350, 5000, &c->p2_star_ms, e) != 0) {
        return -1;
    }
    if (opt_u32(t, "s3_ms", 0xFFFF, 5000, &v, e) != 0) {
        return -1;
    }
    c->s3_ms = (uint16_t)v;
    if (opt_u32(t, "security_boot_delay_ms", 600000, 0, &c->security_boot_delay_ms, e) != 0) {
        return -1;
    }
    if (opt_u32(t, "reset_power_down_ms", 60000, 60, &c->reset_power_down_ms, e) != 0) {
        return -1;
    }
    if (opt_u32(t, "response_delay_ms", 60000, 0, &c->response_delay_ms, e) != 0) {
        return -1;
    }
    if ((c->p2_ms == 0U) || (c->p2_star_ms <= c->p2_ms)) {
        return fail(e, "timing: require 0 < p2_ms < p2_star_ms");
    }
    return 0;
}

static int parse_isotp(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"bs", "stmin", "tx_padding", NULL};
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(root, "isotp");
    uint32_t v = 0;
    c->tx_padding = -1;
    if (t == NULL) {
        return 0;
    }
    if (check_keys(t, keys, "isotp", e) != 0) {
        return -1;
    }
    if (opt_u32(t, "bs", 0xFF, 0, &v, e) != 0) {
        return -1;
    }
    c->isotp_bs = (uint8_t)v;
    if (opt_u32(t, "stmin", 0xFF, 0, &v, e) != 0) {
        return -1;
    }
    c->isotp_stmin = (uint8_t)v;
    const cJSON *p = cJSON_GetObjectItemCaseSensitive(t, "tx_padding");
    if ((p != NULL) && !cJSON_IsNull(p)) {
        if (parse_u32_item(p, 0xFF, &v, "tx_padding", e) != 0) {
            return -1;
        }
        c->tx_padding = (int)v;
    }
    return 0;
}

static int parse_sessions_cfg(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"id", "from", NULL};
    const cJSON *arr = NULL;
    if (arr_items(root, "sessions", &arr, &c->n_sessions, e) != 0) {
        return -1;
    }
    if (c->n_sessions == 0U) {
        /* default: default + programming + extended, unrestricted */
        c->n_sessions = 3;
        c->sessions = calloc(3, sizeof(session_cfg_t));
        if (c->sessions == NULL) {
            return fail(e, "out of memory");
        }
        c->sessions[0].id = 1;
        c->sessions[1].id = 2;
        c->sessions[2].id = 3;
        return 0;
    }
    c->sessions = calloc(c->n_sessions, sizeof(session_cfg_t));
    if (c->sessions == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        uint32_t v = 0;
        if ((check_keys(it, keys, "sessions[]", e) != 0) ||
            (req_u32(it, "id", 0x7F, &v, "sessions[]", e) != 0)) {
            return -1;
        }
        c->sessions[i].id = (uint8_t)v;
        if (parse_sessions(it, "from", &c->sessions[i].from, e) != 0) {
            return -1;
        }
        i++;
    }
    return 0;
}

static int parse_services(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"enabled", "sessions", "security", NULL};
    const cJSON *obj = cJSON_GetObjectItemCaseSensitive(root, "services");
    if (obj == NULL) {
        return 0;
    }
    if (!cJSON_IsObject(obj)) {
        return fail(e, "services: expected object keyed by SID");
    }
    c->n_services = (uint16_t)cJSON_GetArraySize(obj);
    c->services = calloc(c->n_services ? c->n_services : 1U, sizeof(service_cfg_t));
    if (c->services == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    for (const cJSON *it = obj->child; it != NULL; it = it->next) {
        if (it->string[0] == '_') {
            c->n_services--;
            continue;
        }
        char *end = NULL;
        unsigned long sid = strtoul(it->string, &end, 0);
        if ((end == it->string) || (*end != '\0') || (sid > 0xFFU)) {
            return fail(e, "services: invalid SID key \"%s\"", it->string);
        }
        if (check_keys(it, keys, "services{}", e) != 0) {
            return -1;
        }
        c->services[i].sid = (uint8_t)sid;
        c->services[i].enabled = opt_bool(it, "enabled", true);
        if (parse_access(it, "sessions", "security", &c->services[i].access, e) != 0) {
            return -1;
        }
        i++;
    }
    return 0;
}

static int parse_dids(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"id",          "hex",           "ascii",          "size",
                                       "source",      "read",          "write",          "io_control",
                                       "read_sessions", "read_security", "write_sessions",
                                       "write_security", "io_sessions",  "io_security",   NULL};
    const cJSON *arr = NULL;
    if (arr_items(root, "dids", &arr, &c->n_dids, e) != 0) {
        return -1;
    }
    c->dids = calloc(c->n_dids ? c->n_dids : 1U, sizeof(did_cfg_t));
    if (c->dids == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        did_cfg_t *d = &c->dids[i++];
        uint32_t v = 0;
        uint32_t size = 0;
        if ((check_keys(it, keys, "dids[]", e) != 0) ||
            (req_u32(it, "id", 0xFFFF, &v, "dids[]", e) != 0) ||
            (opt_u32(it, "size", 4000, 0, &size, e) != 0)) {
            return -1;
        }
        d->id = (uint16_t)v;
        for (uint16_t k = 0; k + 1U < i; k++) {
            if (c->dids[k].id == d->id) {
                return fail(e, "dids: duplicate DID 0x%04X", d->id);
            }
        }
        const cJSON *src = cJSON_GetObjectItemCaseSensitive(it, "source");
        const cJSON *hex = cJSON_GetObjectItemCaseSensitive(it, "hex");
        const cJSON *asc = cJSON_GetObjectItemCaseSensitive(it, "ascii");
        uint32_t len = 0;
        uint8_t *val = NULL;
        if (src != NULL) {
            if (!cJSON_IsString(src) || (strcmp(src->valuestring, "active_session") != 0)) {
                return fail(e, "DID 0x%04X: source must be \"active_session\"", d->id);
            }
            d->source = DID_SRC_ACTIVE_SESSION;
            len = 1;
            val = calloc(1, 1);
        } else if (cJSON_IsString(hex)) {
            if (parse_hex(hex->valuestring, &val, &len, "hex", e) != 0) {
                return -1;
            }
        } else if (cJSON_IsString(asc)) {
            len = (uint32_t)strlen(asc->valuestring);
            val = malloc(len + 1U);
            if (val != NULL) {
                (void)memcpy(val, asc->valuestring, len + 1U);
            }
        } else {
            return fail(e, "DID 0x%04X: needs \"hex\", \"ascii\" or \"source\"", d->id);
        }
        if (val == NULL) {
            return fail(e, "out of memory");
        }
        if (size != 0U) {
            if (len > size) {
                free(val);
                return fail(e, "DID 0x%04X: value longer than size", d->id);
            }
            uint8_t *p = calloc(size, 1); /* pad with 0x00 */
            if (p == NULL) {
                free(val);
                return fail(e, "out of memory");
            }
            (void)memcpy(p, val, len);
            free(val);
            val = p;
            len = size;
        }
        if ((len == 0U) || (len > 4000U)) {
            free(val);
            return fail(e, "DID 0x%04X: length must be 1..4000", d->id);
        }
        d->init = val;
        d->len = (uint16_t)len;
        d->readable = opt_bool(it, "read", true);
        d->writable = opt_bool(it, "write", false);
        d->io_control = opt_bool(it, "io_control", false);
        if ((parse_access(it, "read_sessions", "read_security", &d->read, e) != 0) ||
            (parse_access(it, "write_sessions", "write_security", &d->write, e) != 0) ||
            (parse_access(it, "io_sessions", "io_security", &d->io, e) != 0)) {
            return -1;
        }
    }
    return 0;
}

static int parse_security(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"level",    "seed",         "seed_mode",  "algorithm",
                                       "constant", "sessions",     "max_attempts", "lockout_ms",
                                       NULL};
    const cJSON *arr = NULL;
    if (arr_items(root, "security", &arr, &c->n_sec, e) != 0) {
        return -1;
    }
    c->sec = calloc(c->n_sec ? c->n_sec : 1U, sizeof(sec_level_cfg_t));
    if (c->sec == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        sec_level_cfg_t *s = &c->sec[i++];
        uint32_t v = 0;
        if ((check_keys(it, keys, "security[]", e) != 0) ||
            (req_u32(it, "level", 0x7D, &v, "security[]", e) != 0)) {
            return -1;
        }
        if ((v % 2U) == 0U) {
            return fail(e, "security: level must be odd (requestSeed sub-function)");
        }
        s->level = (uint8_t)v;
        if (hex_fixed(it, "seed", s->seed, sizeof(s->seed), &s->seed_len, e) != 0) {
            return -1;
        }
        if (s->seed_len == 0U) {
            return fail(e, "security level 0x%02X: \"seed\" (hex) required", s->level);
        }
        const cJSON *mode = cJSON_GetObjectItemCaseSensitive(it, "seed_mode");
        if (mode != NULL) {
            if (!cJSON_IsString(mode)) {
                return fail(e, "seed_mode: expected string");
            }
            if (strcmp(mode->valuestring, "counter") == 0) {
                s->seed_counter = true;
            } else if (strcmp(mode->valuestring, "fixed") != 0) {
                return fail(e, "seed_mode: \"fixed\" or \"counter\"");
            }
        }
        const cJSON *alg = cJSON_GetObjectItemCaseSensitive(it, "algorithm");
        if (!cJSON_IsString(alg)) {
            return fail(e, "security level 0x%02X: \"algorithm\" required", s->level);
        }
        if (strcmp(alg->valuestring, "xor_ff") == 0) {
            s->alg = SA_ALG_XOR_FF;
        } else if (strcmp(alg->valuestring, "xor_const") == 0) {
            s->alg = SA_ALG_XOR_CONST;
            if (hex_fixed(it, "constant", s->konst, sizeof(s->konst), &s->konst_len, e) != 0) {
                return -1;
            }
            if (s->konst_len == 0U) {
                return fail(e, "xor_const needs \"constant\" (hex)");
            }
        } else {
            return fail(e, "algorithm: \"xor_ff\" or \"xor_const\"");
        }
        if (parse_sessions(it, "sessions", &s->sessions, e) != 0) {
            return -1;
        }
        if (opt_u32(it, "max_attempts", 0xFF, 3, &v, e) != 0) {
            return -1;
        }
        s->max_attempts = (uint8_t)((v == 0U) ? 1U : v);
        if (opt_u32(it, "lockout_ms", 600000, 10000, &s->lockout_ms, e) != 0) {
            return -1;
        }
    }
    return 0;
}

static int parse_routines(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"id",          "action",   "sessions", "security",
                                       "start_result", "stop_result", "results", NULL};
    const cJSON *arr = NULL;
    if (arr_items(root, "routines", &arr, &c->n_routines, e) != 0) {
        return -1;
    }
    c->routines = calloc(c->n_routines ? c->n_routines : 1U, sizeof(routine_cfg_t));
    if (c->routines == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        routine_cfg_t *r = &c->routines[i++];
        uint32_t v = 0;
        if ((check_keys(it, keys, "routines[]", e) != 0) ||
            (req_u32(it, "id", 0xFFFF, &v, "routines[]", e) != 0)) {
            return -1;
        }
        r->id = (uint16_t)v;
        const cJSON *act = cJSON_GetObjectItemCaseSensitive(it, "action");
        r->action = RT_STATIC;
        if (act != NULL) {
            if (!cJSON_IsString(act)) {
                return fail(e, "routine action: expected string");
            }
            if (strcmp(act->valuestring, "crc32") == 0) {
                r->action = RT_CRC32;
            } else if (strcmp(act->valuestring, "erase") == 0) {
                r->action = RT_ERASE;
            } else if (strcmp(act->valuestring, "static") != 0) {
                return fail(e, "routine action: static|crc32|erase");
            }
        }
        if ((parse_access(it, "sessions", "security", &r->access, e) != 0) ||
            (opt_hex(it, "start_result", &r->start_result, &r->start_result_len, e) != 0) ||
            (opt_hex(it, "stop_result", &r->stop_result, &r->stop_result_len, e) != 0) ||
            (opt_hex(it, "results", &r->results, &r->results_len, e) != 0)) {
            return -1;
        }
    }
    return 0;
}

static int parse_memory(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const mkeys[] = {"max_block_length", "regions", NULL};
    static const char *const rkeys[] = {"name", "address", "size", "fill", "init_hex",
                                        "read", "download", NULL};
    const cJSON *m = cJSON_GetObjectItemCaseSensitive(root, "memory");
    uint32_t v = 0;
    c->max_block_length = 0x0102;
    if (m == NULL) {
        return 0;
    }
    if ((check_keys(m, mkeys, "memory", e) != 0) ||
        (opt_u32(m, "max_block_length", UDS_TP_MTU, 0x0102, &v, e) != 0)) {
        return -1;
    }
    if (v < 3U) {
        return fail(e, "memory.max_block_length must be >= 3");
    }
    c->max_block_length = (uint16_t)v;
    const cJSON *arr = NULL;
    if (arr_items(m, "regions", &arr, &c->n_mem, e) != 0) {
        return -1;
    }
    c->mem = calloc(c->n_mem ? c->n_mem : 1U, sizeof(mem_region_cfg_t));
    if (c->mem == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        mem_region_cfg_t *r = &c->mem[i++];
        if ((check_keys(it, rkeys, "memory.regions[]", e) != 0) ||
            (req_u32(it, "address", 0xFFFFFFFFU, &r->addr, "memory.regions[]", e) != 0) ||
            (req_u32(it, "size", 16U * 1024U * 1024U, &r->size, "memory.regions[]", e) != 0) ||
            (opt_u32(it, "fill", 0xFF, 0xFF, &v, e) != 0)) {
            return -1;
        }
        r->fill = (uint8_t)v;
        if ((r->size == 0U) || (((uint64_t)r->addr + r->size) > 0x100000000ULL)) {
            return fail(e, "memory region: invalid address/size");
        }
        const cJSON *nm = cJSON_GetObjectItemCaseSensitive(it, "name");
        (void)snprintf(r->name, sizeof(r->name), "%s",
                       cJSON_IsString(nm) ? nm->valuestring : "region");
        const cJSON *ih = cJSON_GetObjectItemCaseSensitive(it, "init_hex");
        if (cJSON_IsString(ih)) {
            if (parse_hex(ih->valuestring, &r->init, &r->init_len, "init_hex", e) != 0) {
                return -1;
            }
            if (r->init_len > r->size) {
                return fail(e, "memory region %s: init_hex larger than size", r->name);
            }
        }
        r->readable = opt_bool(it, "read", true);
        r->downloadable = opt_bool(it, "download", false);
        for (uint16_t k = 0; k + 1U < i; k++) {
            const mem_region_cfg_t *o = &c->mem[k];
            if ((r->addr < o->addr + o->size) && (o->addr < r->addr + r->size)) {
                return fail(e, "memory regions %s and %s overlap", r->name, o->name);
            }
        }
    }
    return 0;
}

static int parse_records(const cJSON *arr, bool snapshot, dtc_record_cfg_t **out, uint16_t *n,
                         errbuf_t *e) {
    static const char *const skeys[] = {"record", "dids", NULL};
    static const char *const dkeys[] = {"id", "hex", NULL};
    static const char *const ekeys[] = {"record", "hex", NULL};
    *out = NULL;
    *n = 0;
    if (arr == NULL) {
        return 0;
    }
    if (!cJSON_IsArray(arr)) {
        return fail(e, "dtc records: expected array");
    }
    int sz = cJSON_GetArraySize(arr);
    *out = calloc(sz ? (size_t)sz : 1U, sizeof(dtc_record_cfg_t));
    if (*out == NULL) {
        return fail(e, "out of memory");
    }
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        dtc_record_cfg_t *r = &(*out)[(*n)++];
        uint32_t v = 0;
        if ((check_keys(it, snapshot ? skeys : ekeys, "dtc record", e) != 0) ||
            (req_u32(it, "record", 0xFE, &v, "dtc record", e) != 0)) {
            return -1;
        }
        r->record = (uint8_t)v;
        if (!snapshot) {
            if (opt_hex(it, "hex", &r->data, &r->len, e) != 0) {
                return -1;
            }
            if (r->len == 0U) {
                return fail(e, "ext_data record needs \"hex\"");
            }
            continue;
        }
        const cJSON *dids = cJSON_GetObjectItemCaseSensitive(it, "dids");
        if (!cJSON_IsArray(dids)) {
            return fail(e, "snapshot record needs \"dids\" array");
        }
        int nd = cJSON_GetArraySize(dids);
        if ((nd <= 0) || (nd > 255)) {
            return fail(e, "snapshot record: 1..255 dids");
        }
        uint8_t buf[1024];
        size_t pos = 0;
        buf[pos++] = (uint8_t)nd;
        const cJSON *d = NULL;
        cJSON_ArrayForEach(d, dids) {
            uint8_t *h = NULL;
            uint16_t hl = 0;
            if ((check_keys(d, dkeys, "snapshot did", e) != 0) ||
                (req_u32(d, "id", 0xFFFF, &v, "snapshot did", e) != 0) ||
                (opt_hex(d, "hex", &h, &hl, e) != 0)) {
                free(h);
                return -1;
            }
            if ((hl == 0U) || ((pos + 2U + hl) > sizeof(buf))) {
                free(h);
                return fail(e, "snapshot did: bad data length");
            }
            buf[pos++] = (uint8_t)(v >> 8);
            buf[pos++] = (uint8_t)v;
            (void)memcpy(&buf[pos], h, hl);
            pos += hl;
            free(h);
        }
        r->data = malloc(pos);
        if (r->data == NULL) {
            return fail(e, "out of memory");
        }
        (void)memcpy(r->data, buf, pos);
        r->len = (uint16_t)pos;
    }
    return 0;
}

static int parse_dtcs(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"availability_mask", "dtcs", NULL};
    static const char *const dkeys[] = {"dtc", "status", "snapshots", "ext_data", NULL};
    const cJSON *d = cJSON_GetObjectItemCaseSensitive(root, "dtc");
    uint32_t v = 0;
    c->dtc_availability_mask = 0xFF;
    if (d == NULL) {
        return 0;
    }
    if ((check_keys(d, keys, "dtc", e) != 0) ||
        (opt_u32(d, "availability_mask", 0xFF, 0xFF, &v, e) != 0)) {
        return -1;
    }
    c->dtc_availability_mask = (uint8_t)v;
    const cJSON *arr = NULL;
    if (arr_items(d, "dtcs", &arr, &c->n_dtcs, e) != 0) {
        return -1;
    }
    c->dtcs = calloc(c->n_dtcs ? c->n_dtcs : 1U, sizeof(dtc_cfg_t));
    if (c->dtcs == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        dtc_cfg_t *x = &c->dtcs[i++];
        if ((check_keys(it, dkeys, "dtc.dtcs[]", e) != 0) ||
            (req_u32(it, "dtc", 0xFFFFFF, &x->dtc, "dtc.dtcs[]", e) != 0) ||
            (req_u32(it, "status", 0xFF, &v, "dtc.dtcs[]", e) != 0)) {
            return -1;
        }
        x->status = (uint8_t)v;
        if ((parse_records(cJSON_GetObjectItemCaseSensitive(it, "snapshots"), true, &x->snapshots,
                           &x->n_snapshots, e) != 0) ||
            (parse_records(cJSON_GetObjectItemCaseSensitive(it, "ext_data"), false, &x->ext,
                           &x->n_ext, e) != 0)) {
            return -1;
        }
    }
    return 0;
}

static int parse_obd(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"mode01", NULL};
    const cJSON *o = cJSON_GetObjectItemCaseSensitive(root, "obd");
    if (o == NULL) {
        return 0;
    }
    if (check_keys(o, keys, "obd", e) != 0) {
        return -1;
    }
    const cJSON *m = cJSON_GetObjectItemCaseSensitive(o, "mode01");
    if (m == NULL) {
        return 0;
    }
    if (!cJSON_IsObject(m)) {
        return fail(e, "obd.mode01: expected object {\"0x0C\": \"1AF8\"}");
    }
    c->n_obd = (uint16_t)cJSON_GetArraySize(m);
    c->obd = calloc(c->n_obd ? c->n_obd : 1U, sizeof(obd_pid_cfg_t));
    if (c->obd == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    for (const cJSON *it = m->child; it != NULL; it = it->next) {
        char *end = NULL;
        unsigned long pid = strtoul(it->string, &end, 0);
        if ((end == it->string) || (*end != '\0') || (pid > 0xFFU) || ((pid % 0x20U) == 0U)) {
            return fail(e, "obd.mode01: invalid PID key \"%s\" (support PIDs are computed)",
                        it->string);
        }
        if (!cJSON_IsString(it)) {
            return fail(e, "obd.mode01[%s]: expected hex string", it->string);
        }
        uint8_t *h = NULL;
        uint32_t hl = 0;
        if (parse_hex(it->valuestring, &h, &hl, it->string, e) != 0) {
            return -1;
        }
        if ((hl == 0U) || (hl > 8U)) {
            free(h);
            return fail(e, "obd.mode01[%s]: 1..8 data bytes", it->string);
        }
        c->obd[i].pid = (uint8_t)pid;
        (void)memcpy(c->obd[i].data, h, hl);
        c->obd[i].len = (uint8_t)hl;
        free(h);
        i++;
    }
    return 0;
}

static int parse_faults(const cJSON *root, ecu_cfg_t *c, errbuf_t *e) {
    static const char *const keys[] = {"sid",     "id",       "sub",         "nrc",  "pending",
                                       "delay_ms", "no_response", "count", "_comment", NULL};
    const cJSON *arr = NULL;
    if (arr_items(root, "faults", &arr, &c->n_faults, e) != 0) {
        return -1;
    }
    c->faults = calloc(c->n_faults ? c->n_faults : 1U, sizeof(fault_cfg_t));
    if (c->faults == NULL) {
        return fail(e, "out of memory");
    }
    uint16_t i = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
        fault_cfg_t *f = &c->faults[i++];
        uint32_t v = 0;
        int kinds = 0;
        if ((check_keys(it, keys, "faults[]", e) != 0) ||
            (req_u32(it, "sid", 0xFF, &v, "faults[]", e) != 0)) {
            return -1;
        }
        f->sid = (uint8_t)v;
        if (cJSON_GetObjectItemCaseSensitive(it, "id") != NULL) {
            if (req_u32(it, "id", 0xFFFF, &v, "faults[]", e) != 0) {
                return -1;
            }
            f->has_id = true;
            f->id = (uint16_t)v;
        }
        if (cJSON_GetObjectItemCaseSensitive(it, "sub") != NULL) {
            if (req_u32(it, "sub", 0x7F, &v, "faults[]", e) != 0) {
                return -1;
            }
            f->has_sub = true;
            f->sub = (uint8_t)v;
        }
        if (cJSON_GetObjectItemCaseSensitive(it, "nrc") != NULL) {
            if (req_u32(it, "nrc", 0xFF, &v, "faults[]", e) != 0) {
                return -1;
            }
            if ((v == 0U) || (v == 0x78U)) {
                return fail(e, "faults[]: nrc must be 0x01..0xFF and not 0x78 (use pending)");
            }
            f->kind = FAULT_NRC;
            f->nrc = (uint8_t)v;
            kinds++;
        }
        if (cJSON_GetObjectItemCaseSensitive(it, "pending") != NULL) {
            if (req_u32(it, "pending", 1000, &v, "faults[]", e) != 0) {
                return -1;
            }
            f->kind = FAULT_PENDING;
            f->pending = (uint16_t)v;
            kinds++;
        }
        if (cJSON_GetObjectItemCaseSensitive(it, "delay_ms") != NULL) {
            if (req_u32(it, "delay_ms", 600000, &f->delay_ms, "faults[]", e) != 0) {
                return -1;
            }
            f->kind = FAULT_DELAY;
            kinds++;
        }
        if (opt_bool(it, "no_response", false)) {
            f->kind = FAULT_NO_RESPONSE;
            kinds++;
        }
        if (kinds != 1) {
            return fail(e, "faults[]: exactly one of nrc|pending|delay_ms|no_response required");
        }
        if (opt_u32(it, "count", 0xFFFFFFFFU, 0, &f->count, e) != 0) {
            return -1;
        }
    }
    return 0;
}

int cfg_load(const char *path, ecu_cfg_t *out, char *err, size_t errlen) {
    static const char *const keys[] = {"timing", "isotp",    "sessions", "services", "dids",
                                       "security", "routines", "memory",   "dtc",      "obd",
                                       "faults", "name",     NULL};
    errbuf_t e = {err, errlen};
    (void)memset(out, 0, sizeof(*out));

    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        return fail(&e, "cannot open %s: %s", path, strerror(errno));
    }
    char *text = NULL;
    size_t cap = 0;
    size_t len = 0;
    for (;;) {
        if (len + 4096U + 1U > cap) {
            cap = (cap == 0U) ? 65536U : cap * 2U;
            char *nt = realloc(text, cap);
            if (nt == NULL) {
                free(text);
                (void)fclose(f);
                return fail(&e, "out of memory");
            }
            text = nt;
        }
        size_t r = fread(text + len, 1, 4096, f);
        len += r;
        if (r < 4096U) {
            break;
        }
    }
    (void)fclose(f);
    text[len] = '\0';

    cJSON *root = cJSON_ParseWithLength(text, len);
    if (root == NULL) {
        /* the error pointer points into `text`: format before freeing it */
        const char *ep = cJSON_GetErrorPtr();
        (void)fail(&e, "JSON parse error at offset %ld", (ep != NULL) ? (long)(ep - text) : -1L);
        free(text);
        return -1;
    }
    free(text);
    int rc = -1;
    if ((check_keys(root, keys, "config", &e) == 0) && (parse_timing(root, out, &e) == 0) &&
        (parse_isotp(root, out, &e) == 0) && (parse_sessions_cfg(root, out, &e) == 0) &&
        (parse_services(root, out, &e) == 0) && (parse_dids(root, out, &e) == 0) &&
        (parse_security(root, out, &e) == 0) && (parse_routines(root, out, &e) == 0) &&
        (parse_memory(root, out, &e) == 0) && (parse_dtcs(root, out, &e) == 0) &&
        (parse_obd(root, out, &e) == 0) && (parse_faults(root, out, &e) == 0)) {
        rc = 0;
    }
    cJSON_Delete(root);
    if (rc != 0) {
        cfg_free(out);
    }
    return rc;
}

void cfg_free(ecu_cfg_t *c) {
    for (uint16_t i = 0; (c->dids != NULL) && (i < c->n_dids); i++) {
        free(c->dids[i].init);
    }
    for (uint16_t i = 0; (c->routines != NULL) && (i < c->n_routines); i++) {
        free(c->routines[i].start_result);
        free(c->routines[i].stop_result);
        free(c->routines[i].results);
    }
    for (uint16_t i = 0; (c->mem != NULL) && (i < c->n_mem); i++) {
        free(c->mem[i].init);
    }
    for (uint16_t i = 0; (c->dtcs != NULL) && (i < c->n_dtcs); i++) {
        for (uint16_t k = 0; (c->dtcs[i].snapshots != NULL) && (k < c->dtcs[i].n_snapshots); k++) {
            free(c->dtcs[i].snapshots[k].data);
        }
        for (uint16_t k = 0; (c->dtcs[i].ext != NULL) && (k < c->dtcs[i].n_ext); k++) {
            free(c->dtcs[i].ext[k].data);
        }
        free(c->dtcs[i].snapshots);
        free(c->dtcs[i].ext);
    }
    free(c->sessions);
    free(c->services);
    free(c->dids);
    free(c->sec);
    free(c->routines);
    free(c->mem);
    free(c->dtcs);
    free(c->obd);
    free(c->faults);
    (void)memset(c, 0, sizeof(*c));
}
