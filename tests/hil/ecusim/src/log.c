/* JSON-lines event log, monotonic clock, CRC32. */
#define _GNU_SOURCE
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "ecusim.h"

static FILE *g_log = NULL;
static struct timespec g_t0;

static uint64_t mono_ns(void) {
    struct timespec ts;
    (void)clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

/* iso14229 is built with UDS_CUSTOM_MILLIS: the upstream UNIX implementation uses
 * gettimeofday(), which is not monotonic (NTP steps would corrupt P2/S3 timers). */
uint32_t UDSMillis(void) { return (uint32_t)(mono_ns() / 1000000ULL); }

double log_now_ms(void) {
    struct timespec ts;
    (void)clock_gettime(CLOCK_MONOTONIC, &ts);
    double s = (double)(ts.tv_sec - g_t0.tv_sec) * 1000.0;
    s += (double)(ts.tv_nsec - g_t0.tv_nsec) / 1.0e6;
    return s;
}

int log_open(const char *path) {
    (void)clock_gettime(CLOCK_MONOTONIC, &g_t0);
    if ((path == NULL) || (strcmp(path, "-") == 0)) {
        g_log = stdout;
        return 0;
    }
    g_log = fopen(path, "a");
    return (g_log == NULL) ? -1 : 0;
}

void log_close(void) {
    if ((g_log != NULL) && (g_log != stdout)) {
        (void)fclose(g_log);
    }
    g_log = NULL;
}

void log_event(const char *fmt, ...) {
    if (g_log == NULL) {
        return;
    }
    struct timespec wall;
    (void)clock_gettime(CLOCK_REALTIME, &wall);
    (void)fprintf(g_log, "{\"t\":%.3f,\"wall\":%lld.%06ld,", log_now_ms(), (long long)wall.tv_sec,
                  wall.tv_nsec / 1000L);
    va_list ap;
    va_start(ap, fmt);
    (void)vfprintf(g_log, fmt, ap);
    va_end(ap);
    (void)fputs("}\n", g_log);
    (void)fflush(g_log);
}

void log_bytes(const char *ev, const char *extra, const uint8_t *buf, size_t len) {
    static const char hexd[] = "0123456789ABCDEF";
    char *hex = malloc((len * 2U) + 1U);
    if (hex == NULL) {
        return;
    }
    for (size_t i = 0; i < len; i++) {
        hex[2U * i] = hexd[buf[i] >> 4];
        hex[(2U * i) + 1U] = hexd[buf[i] & 0x0FU];
    }
    hex[len * 2U] = '\0';
    log_event("\"ev\":\"%s\"%s%s,\"len\":%zu,\"data\":\"%s\"", ev,
              ((extra != NULL) && (extra[0] != '\0')) ? "," : "", (extra != NULL) ? extra : "", len,
              hex);
    free(hex);
}

uint32_t crc32_ieee(const uint8_t *buf, size_t len) {
    uint32_t crc = 0xFFFFFFFFU;
    for (size_t i = 0; i < len; i++) {
        crc ^= buf[i];
        for (int k = 0; k < 8; k++) {
            uint32_t mask = (uint32_t)(-(int32_t)(crc & 1U));
            crc = (crc >> 1) ^ (0xEDB88320U & mask);
        }
    }
    return crc ^ 0xFFFFFFFFU;
}
