# ecusim — virtual UDS ECU (test-only, not part of the NexusCAN product)
#
#   make            -> build/ecusim        (-O2, -Wall -Wextra -Werror)
#   make asan       -> build/asan/ecusim   (-fsanitize=address,undefined)
#   make clean
#
# Vendored sources are never edited in place: they are copied to build/gen/ and every
# third_party/iso14229/patches/*.patch (sorted) is applied to that copy with `patch -p1`.

CC       ?= gcc
BUILD    ?= build
SRC      := src
ISO_DIR  := third_party/iso14229
CJSON    := third_party/cjson
PATCHES  := $(sort $(wildcard $(ISO_DIR)/patches/*.patch))
GEN      := $(BUILD)/gen

WARN     := -Wall -Wextra -Werror
DEFS     := \
            -DUDS_CUSTOM_MILLIS \
            -DUDS_SERVER_0x27_BRUTE_FORCE_MITIGATION_AUTH_FAIL_DELAY_MS=0U \
            -DUDS_SERVER_0x27_BRUTE_FORCE_MITIGATION_BOOT_DELAY_MS=0U
OPT      ?= -O2 -g
# mandatory flags are kept out of CFLAGS so a command-line CFLAGS=... cannot drop them
ALL_CFLAGS := $(OPT) -std=gnu11 $(WARN) $(DEFS) $(EXTRA_CFLAGS) $(CFLAGS)
ALL_CPPFLAGS := -I$(GEN) -I$(CJSON) -I$(SRC) $(CPPFLAGS)
ALL_LDFLAGS  := $(EXTRA_LDFLAGS) $(LDFLAGS)

APP_SRCS := $(SRC)/main.c $(SRC)/ecu.c $(SRC)/config.c $(SRC)/tp.c $(SRC)/log.c
OBJS     := $(patsubst $(SRC)/%.c,$(BUILD)/%.o,$(APP_SRCS)) $(BUILD)/iso14229.o $(BUILD)/cJSON.o

.PHONY: all asan clean
all: $(BUILD)/ecusim

$(GEN)/.stamp: $(ISO_DIR)/iso14229.c $(ISO_DIR)/iso14229.h $(PATCHES)
	@mkdir -p $(GEN)
	cp $(ISO_DIR)/iso14229.c $(ISO_DIR)/iso14229.h $(GEN)/
	@for p in $(PATCHES); do echo "applying $$p"; patch -d $(GEN) -p1 --forward --batch < $$p || exit 1; done
	@touch $@

$(BUILD)/iso14229.o: $(GEN)/.stamp
	$(CC) $(ALL_CPPFLAGS) $(ALL_CFLAGS) -c $(GEN)/iso14229.c -o $@

$(BUILD)/cJSON.o: $(CJSON)/cJSON.c $(CJSON)/cJSON.h
	@mkdir -p $(BUILD)
	$(CC) $(ALL_CPPFLAGS) $(ALL_CFLAGS) -c $< -o $@

$(BUILD)/%.o: $(SRC)/%.c $(SRC)/ecusim.h $(GEN)/.stamp
	@mkdir -p $(BUILD)
	$(CC) $(ALL_CPPFLAGS) $(ALL_CFLAGS) -c $< -o $@

$(BUILD)/ecusim: $(OBJS)
	$(CC) $(ALL_CFLAGS) $(OBJS) $(ALL_LDFLAGS) -o $@

asan:
	$(MAKE) BUILD=build/asan OPT="-O1 -g -fno-omit-frame-pointer" \
	    EXTRA_CFLAGS="-fsanitize=address,undefined -fno-sanitize-recover=undefined" \
	    EXTRA_LDFLAGS="-fsanitize=address,undefined"

clean:
	rm -rf build
