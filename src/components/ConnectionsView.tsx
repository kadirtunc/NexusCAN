import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  ExternalLink,
  Laptop,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  TriangleAlert,
  Unlock,
  Usb,
  X,
} from 'lucide-react';
import {
  apiConnectBus,
  apiDisconnectAllBuses,
  apiDisconnectBus,
  apiProbeDrivers,
} from '../services/ipcClient';
import {
  DATA_BITRATES_FD,
  KVASER_ADAPTER_CHANNELS,
  MAX_BUS_ID,
  NOMINAL_BITRATES,
  PCAN_DEFAULT_CHANNEL,
  PCAN_MANUAL_ENTRY_HINT,
  getDetectedChannels,
  pcanCandidateChannels,
  SERIAL_BAUD_RATES,
  VECTOR_XL_ADAPTER_CHANNELS,
  defaultSerialPortPlaceholder,
  pickNextUnusedChannel,
  pickNextUnusedSerialPort,
  type SavedConnectionProfile,
  buildChannelConfigForProfile,
  clampBusId,
  connectionStore,
  findNextFreeBusId,
  resolveDeviceIdForProfile,
  useConnectionStore,
} from '../store/connectionStore';
import {
  ensureMockPresetDatabasesLoaded,
  syncAllBusDatabasesWithBackend,
} from '../utils/busDatabaseSync';
import { describeTxError, setBusTxArmed } from '../store/busTxControl';
import { logUiDebugEvent } from '../store/debugConsoleStore';
import { telemetryStore, useTelemetryHeader } from '../store/telemetryStore';
import { transmitStore } from '../store/transmitStore';
import { useI18n, type TranslationKey } from '../i18n';
import type {
  DetectedChannelDetailDto,
  DeviceDescriptorDto,
  DriverFamilyId,
  DriverFamilyStatusDto,
  DriverProbeReportDto,
  OsSetupStepDto,
  SerialPortInfoDto,
  UsbCanDeviceDto,
} from '../types/hal';
import { BusStateBadge } from './BusStateBadge';
import { EnforcementBadge } from './EnforcementBadge';
import type { StatusBanner } from './TopBar';
import { DatabaseBindingPicker } from './DatabaseBindingPicker';
import { useDatabaseStore } from '../store/databaseStore';

interface ConnectionsViewProps {
  devices: readonly DeviceDescriptorDto[];
  onRefreshDevices: () => Promise<void>;
  onStatusMessage: (msg: StatusBanner) => void;
}

const DRIVER_FAMILY_OPTIONS: readonly {
  id: DriverFamilyId;
  labelKey: TranslationKey;
  shortTag: string;
}[] = [
  { id: 'socketcan', labelKey: 'conn.driver.socketcan', shortTag: 'SOCKETCAN' },
  { id: 'gs_usb', labelKey: 'conn.driver.gs_usb', shortTag: 'GS_USB' },
  { id: 'slcan', labelKey: 'conn.driver.slcan', shortTag: 'SLCAN' },
  { id: 'pcan', labelKey: 'conn.driver.pcan', shortTag: 'PCAN' },
  { id: 'kvaser', labelKey: 'conn.driver.kvaser', shortTag: 'KVASER' },
  { id: 'vector_xl', labelKey: 'conn.driver.vector_xl', shortTag: 'VECTOR_XL' },
  { id: 'mock', labelKey: 'conn.driver.mock', shortTag: 'MOCK' },
];

interface OsDriverRefData {
  sourceLocations: string[];
  setupSteps: OsSetupStepDto[];
}

const OS_DRIVER_REFERENCE: Record<
  DriverFamilyId,
  Record<'linux' | 'windows' | 'macos', OsDriverRefData>
> = {
  socketcan: {
    linux: {
      sourceLocations: [
        '/sys/class/net/*/type=280 (ARPHRD_CAN)',
        '/proc/net/can (version, stats, rcvlist_all)',
        'libsocketcan / AF_CAN / rtnetlink',
      ],
      setupSteps: [
        {
          title: 'Virtual CAN (vcan0) Setup',
          description:
            'Load the vcan kernel module, create the vcan0 interface, and bring it UP for loopback simulation.',
          commandOrAction:
            'sudo modprobe vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set vcan0 up',
          docUrl: 'https://docs.kernel.org/networking/can.html',
        },
        {
          title: 'Physical CAN Interface (can0 - 500k / 2M CAN-FD)',
          description:
            'Configure nominal and data bitrates, enable CAN-FD, and bring up the hardware interface.',
          commandOrAction:
            'sudo ip link set can0 up type can bitrate 500000 dbitrate 2000000 fd on',
          docUrl: 'https://docs.kernel.org/networking/can.html',
        },
      ],
    },
    windows: {
      sourceLocations: [
        'Not natively supported on Windows (Linux kernel subsystem only)',
      ],
      setupSteps: [
        {
          title: 'WSL2 Forwarding via usbipd-win',
          description:
            'Forward USB-CAN adapters (CANable, PCAN) from Windows host into WSL2 Linux kernel with SocketCAN.',
          commandOrAction: 'usbipd wsl attach --busid <busid>',
          docUrl: 'https://github.com/dorssel/usbipd-win',
        },
        {
          title: 'Use gs_usb or PCAN instead',
          description:
            'On Windows, NexusCAN natively connects to candleLight / gs_usb and PCAN via nusb and PCANBasic.dll without WSL.',
          commandOrAction: null,
          docUrl: null,
        },
      ],
    },
    macos: {
      sourceLocations: [
        'Not supported on macOS (Darwin lacks SocketCAN kernel subsystem)',
      ],
      setupSteps: [
        {
          title: 'Use Native gs_usb or SLCAN',
          description:
            'macOS provides direct zero-driver access to candleLight USB adapters (gs_usb via nusb/IOKit) and USB-serial ports (/dev/cu.*).',
          commandOrAction: null,
          docUrl: null,
        },
      ],
    },
  },
  gs_usb: {
    linux: {
      sourceLocations: [
        '/sys/bus/usb/devices/* (VID: 1D50/606F, 0483/1234)',
        'Linux kernel driver: gs_usb (spawns canX interfaces)',
        '/etc/udev/rules.d/ (non-root raw USB access)',
      ],
      setupSteps: [
        {
          title: 'Install Udev Rules (Non-root user access)',
          description:
            'Grant plugdev/dialout users write access to candleLight/CANable USB devices without root.',
          commandOrAction:
            'echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="606f", MODE="0666"\' | sudo tee /etc/udev/rules.d/99-candlelight.rules && sudo udevadm control --reload-rules && sudo udevadm trigger',
          docUrl: 'https://canable.io/getting-started.html',
        },
        {
          title: 'Kernel module check',
          description:
            'Ensure gs_usb kernel driver is loaded if using SocketCAN translation, or use NexusCAN direct nusb backend.',
          commandOrAction: 'sudo modprobe gs_usb',
          docUrl: null,
        },
      ],
    },
    windows: {
      sourceLocations: [
        'WinUSB / libusbK (Direct USB access via nusb)',
        'SetupAPI Device Instance IDs (VID 1D50 / PID 606F)',
      ],
      setupSteps: [
        {
          title: 'Install WinUSB Driver with Zadig',
          description:
            'CANable / candleLight devices on Windows require the WinUSB driver to be assigned to Interface 0.',
          commandOrAction:
            'Zadig -> Options -> List All Devices -> Select "candleLight USB to CAN" -> Target: WinUSB -> Install Driver',
          docUrl: 'https://zadig.akeo.ie/',
        },
      ],
    },
    macos: {
      sourceLocations: [
        'IOKit USB Subsystem (IOUSBHostDevice)',
        'Direct user-space USB communication via nusb (Zero-driver)',
      ],
      setupSteps: [
        {
          title: 'Plug and Play (No Driver Needed)',
          description:
            'candleLight / CANable 2.0 works natively on macOS via user-space IOKit. No kext or installation required.',
          commandOrAction: null,
          docUrl: 'https://canable.io/',
        },
      ],
    },
  },
  slcan: {
    linux: {
      sourceLocations: [
        '/dev/ttyACM* (CDC-ACM virtual COM ports)',
        '/dev/ttyUSB* (FTDI / CH340 / CP2102 serial ports)',
        '/sys/class/tty/*/device',
      ],
      setupSteps: [
        {
          title: 'Dialout Group Membership',
          description:
            'Add your Linux user account to the dialout group to access serial ports without sudo permissions.',
          commandOrAction: 'sudo usermod -aG dialout $USER && newgrp dialout',
          docUrl: null,
        },
      ],
    },
    windows: {
      sourceLocations: [
        'Win32 SetupAPI / QueryDosDevice (COM1..COM256)',
        'Registry: HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM',
      ],
      setupSteps: [
        {
          title: 'Check Device Manager COM Port',
          description:
            'Connect your Lawicel / USBtin / CAN232 adapter and verify assigned COM port in Device Manager.',
          commandOrAction: 'mode COM3: baud=1000000 parity=n data=8 stop=1',
          docUrl: null,
        },
      ],
    },
    macos: {
      sourceLocations: [
        '/dev/cu.usbmodem* (Callout CDC-ACM devices)',
        '/dev/cu.usbserial* (Callout FTDI/Silicon Labs devices)',
      ],
      setupSteps: [
        {
          title: 'Use /dev/cu.* Callout Devices',
          description:
            'Always select /dev/cu.* instead of /dev/tty.* on macOS. The tty device waits for hardware carrier detect (DCD) and blocks.',
          commandOrAction: 'ls -l /dev/cu.usb*',
          docUrl: null,
        },
      ],
    },
  },
  pcan: {
    linux: {
      sourceLocations: [
        'libpcanbasic.so (Dynamic library via dlopen)',
        '/usr/lib/libpcanbasic.so, /usr/local/lib/libpcanbasic.so',
        'Kernel driver: pcan / peak_usb (creates canX interfaces)',
      ],
      setupSteps: [
        {
          title: 'Install PEAK Linux Driver & Library',
          description:
            'Download the official PEAK-System Linux driver and compile libpcanbasic.so.',
          commandOrAction:
            'tar -xzf peak-linux-driver-*.tar.gz && cd peak-linux-driver-* && make && sudo make install',
          docUrl: 'https://www.peak-system.com/PCAN-Basic.239.0.html',
        },
      ],
    },
    windows: {
      sourceLocations: [
        'C:\\Windows\\System32\\PCANBasic.dll (64-bit DLL)',
        'C:\\Windows\\SysWOW64\\PCANBasic.dll',
        'PEAK-System OEM Driver (PeakOem.sys)',
      ],
      setupSteps: [
        {
          title: 'Install PCAN-Basic x64 Driver Package',
          description:
            'Run PeakDrv.exe setup or copy 64-bit PCANBasic.dll to C:\\Windows\\System32.',
          commandOrAction: 'https://www.peak-system.com/quick/DrvSetup',
          docUrl: 'https://www.peak-system.com/PCAN-Basic.239.0.html',
        },
      ],
    },
    macos: {
      sourceLocations: [
        '/opt/homebrew/lib/libPCBUSB.dylib (Apple Silicon Homebrew)',
        '/usr/local/lib/libPCBUSB.dylib (Intel Homebrew)',
        'libPCBUSB (macCAN project)',
      ],
      setupSteps: [
        {
          title: 'Install macCAN PCBUSB library via Homebrew',
          description:
            'macCAN provides user-space PCAN-Basic compatible dynamic library for macOS.',
          commandOrAction: 'brew install mac-can/maccan/pcbusb',
          docUrl: 'https://www.mac-can.com/',
        },
      ],
    },
  },
  kvaser: {
    linux: {
      sourceLocations: [
        'libcanlib.so (Dynamic library via dlopen)',
        '/usr/lib/libcanlib.so, /usr/local/lib/libcanlib.so',
        'Kvaser LINUX Driver and SDK (linuxcan)',
      ],
      setupSteps: [
        {
          title: 'Install Kvaser Linux Driver and SDK',
          description:
            'Download Kvaser LINUX Driver and SDK from kvaser.com, build and install kernel modules and canlib.',
          commandOrAction:
            'tar -xzf linuxcan.tar.gz && cd linuxcan && make && sudo make install',
          docUrl: 'https://www.kvaser.com/developer/canlib-sdk/',
        },
      ],
    },
    windows: {
      sourceLocations: [
        'C:\\Windows\\System32\\canlib32.dll (64-bit Kvaser CANlib)',
        'Kvaser Drivers Setup (kvaser_drivers_setup.exe)',
      ],
      setupSteps: [
        {
          title: 'Install Kvaser Drivers and CANlib SDK',
          description:
            'Download and run Kvaser Driver Setup for Windows to install canlib32.dll in System32.',
          commandOrAction: 'https://www.kvaser.com/downloads-kvaser/',
          docUrl: 'https://www.kvaser.com/developer/canlib-sdk/',
        },
      ],
    },
    macos: {
      sourceLocations: [
        'libcanlib.dylib (MacCAN-KvaserCAN via dlopen)',
        '/opt/homebrew/lib/libcanlib.dylib, /usr/local/lib/libcanlib.dylib',
      ],
      setupSteps: [
        {
          title: 'Install MacCAN KvaserCAN library',
          description:
            'MacCAN driver wrapper for Kvaser Leaf / Memorator USB devices on macOS.',
          commandOrAction: 'brew install mac-can/maccan/kvasercan',
          docUrl: 'https://www.mac-can.com/',
        },
      ],
    },
  },
  vector_xl: {
    linux: {
      sourceLocations: [
        'libvxlapi.so (Vector Driver for Linux / SocketCAN integration)',
      ],
      setupSteps: [
        {
          title: 'Vector Linux Driver Package',
          description:
            'Vector provides proprietary Linux drivers for VN1600/VN5600 network interfaces that integrate with SocketCAN.',
          commandOrAction: null,
          docUrl: 'https://www.vector.com/',
        },
      ],
    },
    windows: {
      sourceLocations: [
        'C:\\Windows\\System32\\vxlapi64.dll (Vector XL Driver Library 64-bit)',
        'Vector Driver Setup (vxlapi.dll / vxlapi64.dll)',
        'Vector Hardware Config (Hardware Channel Assignment)',
      ],
      setupSteps: [
        {
          title: 'Install Vector Driver Setup & XL Driver Library',
          description:
            'Install Vector Driver Setup package for VN16xx / VN56xx devices. Verify vxlapi64.dll is in System32.',
          commandOrAction:
            'Open Vector Hardware Config -> Assign CAN Channels to Application Ports',
          docUrl:
            'https://www.vector.com/int/en/products/products-a-z/libraries/xl-driver-library/',
        },
      ],
    },
    macos: {
      sourceLocations: [
        'Not supported on macOS (Vector XL Driver Library is Windows-only)',
      ],
      setupSteps: [
        {
          title: 'Windows-only Driver',
          description:
            'Vector XL Driver Library (vxlapi64.dll) is exclusively supported on Windows systems.',
          commandOrAction: null,
          docUrl: null,
        },
      ],
    },
  },
  mock: {
    linux: {
      sourceLocations: [
        'In-Memory synthetic deterministic EV powertrain & BMS simulation engine',
      ],
      setupSteps: [
        {
          title: 'Deterministic Test Generator',
          description:
            'Generates multi-mux BMS cell matrix and powertrain CAN/CAN-FD frames at 16Hz..50kHz without physical hardware.',
          commandOrAction: null,
          docUrl: null,
        },
      ],
    },
    windows: {
      sourceLocations: [
        'In-Memory synthetic deterministic EV powertrain & BMS simulation engine',
      ],
      setupSteps: [
        {
          title: 'Deterministic Test Generator',
          description:
            'Generates multi-mux BMS cell matrix and powertrain CAN/CAN-FD frames at 16Hz..50kHz without physical hardware.',
          commandOrAction: null,
          docUrl: null,
        },
      ],
    },
    macos: {
      sourceLocations: [
        'In-Memory synthetic deterministic EV powertrain & BMS simulation engine',
      ],
      setupSteps: [
        {
          title: 'Deterministic Test Generator',
          description:
            'Generates multi-mux BMS cell matrix and powertrain CAN/CAN-FD frames at 16Hz..50kHz without physical hardware.',
          commandOrAction: null,
          docUrl: null,
        },
      ],
    },
  },
};

function createBlankProfile(
  nextBusId: number,
  devices?: readonly DeviceDescriptorDto[],
  probeReport?: DriverProbeReportDto | null,
  existingProfiles: readonly SavedConnectionProfile[] = [],
): SavedConnectionProfile {
  const hostOs = (probeReport?.hostOs ?? 'linux').toLowerCase();
  const serialPorts = probeReport?.serialPorts ?? [];
  const usbDevices = probeReport?.usbDevices ?? [];
  const families = probeReport?.families ?? [];

  const socketcanFamily = families.find((f) => f.familyId === 'socketcan');
  const gsUsbFamily = families.find((f) => f.familyId === 'gs_usb');
  const pcanFamily = families.find((f) => f.familyId === 'pcan');
  const kvaserFamily = families.find((f) => f.familyId === 'kvaser');
  const vectorXlFamily = families.find((f) => f.familyId === 'vector_xl');

  // Check for ready hardware first
  const detectedSocketCan = devices?.find((d) => d.driverId === 'socketcan');
  const hasSocketCan =
    hostOs === 'linux' &&
    (Boolean(socketcanFamily?.detectedChannels.length) ||
      Boolean(detectedSocketCan) ||
      socketcanFamily?.installed);

  if (hasSocketCan) {
    const socketcanCandidates = Array.from(
      new Set(
        [
          ...(socketcanFamily?.detectedChannels ?? []),
          detectedSocketCan?.channelName,
          'can0',
          'can1',
          'vcan0',
          'vcan1',
        ].filter((x): x is string => Boolean(x)),
      ),
    );
    const channel = pickNextUnusedChannel(
      'socketcan',
      socketcanCandidates,
      existingProfiles,
      undefined,
      'vcan0',
    );
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `SocketCAN (${channel})`,
      busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
      driverFamily: 'socketcan',
      deviceId: `socketcan:${channel}`,
      adapterChannel: channel,
      serialPort: '',
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'fd_500k_2m',
      bitrate: 500_000,
      enableFd: true,
      dataBitrate: 2_000_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'Linux Native SocketCAN (can / vcan)',
      databaseIds: [],
    };
  }

  // Check gs_usb (cross-OS)
  const gsUsbReady =
    gsUsbFamily?.installed ||
    gsUsbFamily?.hardwarePresent ||
    usbDevices.some((u) => u.matchedFamily === 'gs_usb');
  if (gsUsbReady) {
    const gsUsbCandidates = Array.from(
      new Set([
        ...(gsUsbFamily?.detectedChannels ?? []),
        ...usbDevices
          .filter((u) => u.matchedFamily === 'gs_usb')
          .map(
            (u) =>
              (u.suggestedChannel?.includes(':')
                ? u.suggestedChannel.split(':')[1]
                : u.suggestedChannel) || '0',
          ),
        '0',
        '1',
        '2',
        '3',
      ]),
    );
    const devCh = pickNextUnusedChannel(
      'gs_usb',
      gsUsbCandidates,
      existingProfiles,
      undefined,
      '0',
    );
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `USB-CAN gs_usb (ch${devCh})`,
      busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
      driverFamily: 'gs_usb',
      deviceId: `gs_usb:${devCh}`,
      adapterChannel: devCh,
      serialPort: '',
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'fd_500k_2m',
      bitrate: 500_000,
      enableFd: true,
      dataBitrate: 2_000_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'USB-CAN candleLight / CANable 2.0',
      databaseIds: [],
    };
  }

  // Check PCAN
  if (pcanFamily?.installed || pcanFamily?.hardwarePresent) {
    const candidates = pcanCandidateChannels(pcanFamily);
    const ch = pickNextUnusedChannel(
      'pcan',
      candidates,
      existingProfiles,
      undefined,
      PCAN_DEFAULT_CHANNEL,
    );
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `PCAN (${ch})`,
      busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
      driverFamily: 'pcan',
      deviceId: `pcan:${ch}`,
      adapterChannel: ch,
      serialPort: '',
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'fd_500k_2m',
      bitrate: 500_000,
      enableFd: true,
      dataBitrate: 2_000_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'PEAK PCAN-Basic',
      databaseIds: [],
    };
  }

  // Check Kvaser
  if (kvaserFamily?.installed || kvaserFamily?.hardwarePresent) {
    const candidates = kvaserFamily.detectedChannels.length
      ? kvaserFamily.detectedChannels
      : KVASER_ADAPTER_CHANNELS;
    const ch = pickNextUnusedChannel(
      'kvaser',
      candidates,
      existingProfiles,
      undefined,
      '0',
    );
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `Kvaser CANlib (ch${ch})`,
      busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
      driverFamily: 'kvaser',
      deviceId: `kvaser:${ch}`,
      adapterChannel: ch,
      serialPort: '',
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'fd_500k_2m',
      bitrate: 500_000,
      enableFd: true,
      dataBitrate: 2_000_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'Kvaser CANlib',
      databaseIds: [],
    };
  }

  // Check Vector XL
  if (vectorXlFamily?.installed || vectorXlFamily?.hardwarePresent) {
    const candidates = vectorXlFamily.detectedChannels.length
      ? vectorXlFamily.detectedChannels
      : VECTOR_XL_ADAPTER_CHANNELS;
    const ch = pickNextUnusedChannel(
      'vector_xl',
      candidates,
      existingProfiles,
      undefined,
      '0',
    );
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `Vector XL (ch${ch})`,
      busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
      driverFamily: 'vector_xl',
      deviceId: `vector_xl:${ch}`,
      adapterChannel: ch,
      serialPort: '',
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'fd_500k_2m',
      bitrate: 500_000,
      enableFd: true,
      dataBitrate: 2_000_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'Vector XL Driver Library',
      databaseIds: [],
    };
  }

  // Check Serial / SLCAN
  if (serialPorts.length > 0) {
    const serialCandidates = serialPorts.map((s) => s.portName);
    const sp = pickNextUnusedSerialPort(
      serialCandidates,
      existingProfiles,
      undefined,
      defaultSerialPortPlaceholder(hostOs),
    );
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `SLCAN (${sp})`,
      busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
      driverFamily: 'slcan',
      deviceId: `slcan:${sp}`,
      adapterChannel: 'slcan0',
      serialPort: sp,
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'can_500k',
      bitrate: 500_000,
      enableFd: false,
      dataBitrate: 500_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'Serial / USB-CDC Lawicel SLCAN',
      databaseIds: [],
    };
  }

  // Default fallback per OS
  const defaultPort = defaultSerialPortPlaceholder(hostOs);
  if (hostOs === 'linux') {
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `SocketCAN (vcan0)`,
      busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
      driverFamily: 'socketcan',
      deviceId: 'socketcan:vcan0',
      adapterChannel: 'vcan0',
      serialPort: '',
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'fd_500k_2m',
      bitrate: 500_000,
      enableFd: true,
      dataBitrate: 2_000_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'Linux Native SocketCAN (vcan0 virtual)',
      databaseIds: [],
    };
  }

  return {
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `New Bus ${nextBusId + 1} (SLCAN)`,
    busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
    driverFamily: 'slcan',
    deviceId: `slcan:${defaultPort}`,
    adapterChannel: 'slcan0',
    serialPort: defaultPort,
    serialBaudRate: 1_000_000,
    serialDtrRts: true,
    bitrateProfileId: 'can_500k',
    bitrate: 500_000,
    enableFd: false,
    dataBitrate: 500_000,
    listenOnly: true,
    mockFpsPreset: null,
    autoConnectOnProjectLoad: false,
    notes: '',
    databaseIds: [],
  };
}

function createMockProfile(nextBusId: number): SavedConnectionProfile {
  return {
    id: `conn-mock-${Date.now()}`,
    name: 'EV Powertrain + BMS Sim (mock0)',
    busId: Math.max(0, Math.min(MAX_BUS_ID, nextBusId)),
    driverFamily: 'mock',
    deviceId: 'mock:mock0',
    adapterChannel: 'mock0',
    serialPort: '',
    serialBaudRate: 1_000_000,
    serialDtrRts: true,
    bitrateProfileId: 'fd_500k_2m',
    bitrate: 500_000,
    enableFd: true,
    dataBitrate: 2_000_000,
    listenOnly: true,
    mockFpsPreset: null,
    autoConnectOnProjectLoad: false,
    notes: 'Synthetic multi-mux EV/BMS generator [Test Only]',
    databaseIds: [],
  };
}

function formatBitrateShort(bps: number): string {
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(bps % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  return `${Math.round(bps / 1_000)}k`;
}

export const ConnectionsView: React.FC<ConnectionsViewProps> = ({
  devices,
  onRefreshDevices,
  onStatusMessage,
}) => {
  const { t } = useI18n();
  const connState = useConnectionStore();
  const header = useTelemetryHeader();

  const [probing, setProbing] = useState<boolean>(false);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const [driverDetailsOpen, setDriverDetailsOpen] = useState<boolean>(false);
  const [drawerOsTab, setDrawerOsTab] = useState<'host' | 'linux' | 'windows' | 'macos'>('host');
  const [guideOsPreview, setGuideOsPreview] = useState<'active' | 'linux' | 'windows' | 'macos'>('active');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState<boolean>(() => connState.profiles.length === 0);

  const copyToClipboard = useCallback((text: string, key: string): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 2000);
    }
  }, []);

  const selectedStoredProfile = useMemo(
    () =>
      connState.profiles.find((p) => p.id === connState.selectedProfileId) ??
      connState.profiles[0] ??
      null,
    [connState.profiles, connState.selectedProfileId],
  );

  const dbCatalog = useDatabaseStore().databases;

  const [draft, setDraft] = useState<SavedConnectionProfile>(() =>
    selectedStoredProfile
      ? { ...selectedStoredProfile }
      : createBlankProfile(0, devices, connState.probeReport, connState.profiles),
  );

  useEffect(() => {
    if (selectedStoredProfile) {
      setDraft({ ...selectedStoredProfile });
    }
  }, [selectedStoredProfile]);

  const runDriverProbe = useCallback(
    async (silent = false): Promise<void> => {
      setProbing(true);
      try {
        const [report] = await Promise.all([apiProbeDrivers(), onRefreshDevices()]);
        connectionStore.setProbeReport(report);
        if (!silent) {
          const installedCnt = report.families.filter((f) => f.installed).length;
          onStatusMessage({
            kind: 'info',
            message: t('conn.status.driverCheckComplete', {
              hostOs: report.hostOs,
              ready: installedCnt,
              total: report.families.length,
              serialCount: report.serialPorts.length,
            }),
          });
          logUiDebugEvent({
            severity: 'info',
            category: 'CONN',
            action: 'conn.rescan',
            title: 'Hardware Driver Probe Complete',
            details: `Host: ${report.hostOs}, Ready Drivers: ${installedCnt}/${report.families.length}, Serial Ports: ${report.serialPorts.length}`,
          });
        }
      } catch (err) {
        if (!silent) {
          onStatusMessage({
            kind: 'error',
            message: t('conn.status.driverProbeFailed', {
              err: err instanceof Error ? err.message : String(err),
            }),
          });
        }
      } finally {
        setProbing(false);
      }
    },
    [onRefreshDevices, onStatusMessage, t],
  );

  useEffect(() => {
    void runDriverProbe(true);
    const interval = setInterval(() => {
      void runDriverProbe(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [runDriverProbe]);

  const familyStatusMap = useMemo(() => {
    const map = new Map<string, DriverFamilyStatusDto>();
    if (!connState.probeReport) return map;
    for (const fam of connState.probeReport.families) {
      map.set(fam.familyId.toLowerCase(), fam);
    }
    return map;
  }, [connState.probeReport]);

  const draftDriverStatus = familyStatusMap.get(draft.driverFamily);

  const maxUsedBusId = useMemo(
    () => connState.profiles.reduce((max, p) => Math.max(max, p.busId), 0),
    [connState.profiles],
  );

  const hostEnv = connState.probeReport?.hostEnv;
  const currentHostOs = (connState.probeReport?.hostOs ?? 'linux').toLowerCase();

  const handleSelectDriverFamily = (family: DriverFamilyId): void => {
    setDraft((prev) => {
      let adapterChannel = prev.adapterChannel;
      let serialPort = prev.serialPort;
      let enableFd = prev.enableFd;

      if (family === 'mock') {
        adapterChannel = pickNextUnusedChannel(
          'mock',
          ['mock0', 'mock1'],
          connState.profiles,
          prev.id,
          'mock0',
        );
      } else if (family === 'pcan') {
        const candidates = pcanCandidateChannels(familyStatusMap.get('pcan'));
        adapterChannel = pickNextUnusedChannel(
          'pcan',
          candidates,
          connState.profiles,
          prev.id,
          PCAN_DEFAULT_CHANNEL,
        );
      } else if (family === 'kvaser') {
        const candidates = familyStatusMap.get('kvaser')?.detectedChannels.length
          ? familyStatusMap.get('kvaser')!.detectedChannels
          : KVASER_ADAPTER_CHANNELS;
        adapterChannel = pickNextUnusedChannel(
          'kvaser',
          candidates,
          connState.profiles,
          prev.id,
          '0',
        );
      } else if (family === 'vector_xl') {
        const candidates = familyStatusMap.get('vector_xl')?.detectedChannels.length
          ? familyStatusMap.get('vector_xl')!.detectedChannels
          : VECTOR_XL_ADAPTER_CHANNELS;
        adapterChannel = pickNextUnusedChannel(
          'vector_xl',
          candidates,
          connState.profiles,
          prev.id,
          '0',
        );
        enableFd = true;
      } else if (family === 'socketcan') {
        const candidates = familyStatusMap.get('socketcan')?.detectedChannels.length
          ? familyStatusMap.get('socketcan')!.detectedChannels
          : ['can0', 'can1', 'vcan0', 'vcan1'];
        adapterChannel = pickNextUnusedChannel(
          'socketcan',
          candidates,
          connState.profiles,
          prev.id,
          'vcan0',
        );
        enableFd = true;
      } else if (family === 'gs_usb') {
        const candidates = familyStatusMap.get('gs_usb')?.detectedChannels.length
          ? familyStatusMap.get('gs_usb')!.detectedChannels
          : ['0', '1', '2', '3'];
        adapterChannel = pickNextUnusedChannel(
          'gs_usb',
          candidates,
          connState.profiles,
          prev.id,
          '0',
        );
        enableFd = true;
      } else if (family === 'slcan') {
        const serialCandidates = serialPorts.map((s) => s.portName);
        serialPort = pickNextUnusedSerialPort(
          serialCandidates,
          connState.profiles,
          prev.id,
          defaultSerialPortPlaceholder(connState.probeReport?.hostOs),
        );
        adapterChannel = 'slcan0';
        enableFd = false;
      }

      const updated: SavedConnectionProfile = {
        ...prev,
        driverFamily: family,
        adapterChannel,
        serialPort,
        enableFd,
      };
      updated.deviceId = resolveDeviceIdForProfile(updated);
      return updated;
    });
  };

  const handleQuickAttachUsbDevice = (dev: UsbCanDeviceDto): void => {
    // 1. DFU Bootloader guard: do NOT switch draft to gs_usb silently
    if (dev.matchedFamily === 'dfu_bootloader') {
      handleSelectDriverFamily('gs_usb');
      setGuideOsPreview('active');
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.dfuBootloaderWarning', {
          vidPid: dev.vidPid,
          name: dev.productName || dev.vendorName,
        }),
      });
      return;
    }

    // 2. Parse suggestedChannel (split on first colon)
    let suggestedPrefix: string | null = null;
    let cleanChannel: string | null = null;

    if (dev.suggestedChannel) {
      const colonIdx = dev.suggestedChannel.indexOf(':');
      if (colonIdx !== -1) {
        suggestedPrefix = dev.suggestedChannel.slice(0, colonIdx).toLowerCase();
        cleanChannel = dev.suggestedChannel.slice(colonIdx + 1);
      } else {
        cleanChannel = dev.suggestedChannel;
      }
    }

    // 3. If bound to SocketCAN (e.g. Linux gs_usb/peak_usb/kvaser bound to can0)
    if (suggestedPrefix === 'socketcan') {
      const ch = cleanChannel || 'can0';
      const targetDeviceId = `socketcan:${ch}`;
      const existingMatch = connState.profiles.find((p) => p.deviceId === targetDeviceId);
      if (existingMatch) {
        connectionStore.selectProfile(existingMatch.id);
        setDraft({ ...existingMatch });
        setEditorOpen(true);
        onStatusMessage({
          kind: 'info',
          message: t('conn.bar.prefilledProfile', {
            name: existingMatch.name,
            channel: ch,
          }),
        });
        return;
      }

      const isCurrentDraftLive = header.buses.some((b) => b.busId === draft.busId && b.connected);
      const isCurrentDraftOccupied =
        isCurrentDraftLive ||
        connState.profiles.some((p) => p.id === draft.id && p.deviceId !== targetDeviceId);

      if (isCurrentDraftOccupied) {
        const freeBus = findNextFreeBusId(connState.profiles);
        const newProfile: SavedConnectionProfile = {
          id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: `${dev.productName || dev.vendorName} (${ch})`,
          busId: freeBus,
          driverFamily: 'socketcan',
          deviceId: targetDeviceId,
          adapterChannel: ch,
          serialPort: '',
          serialBaudRate: 1_000_000,
          serialDtrRts: true,
          bitrateProfileId: 'fd_500k_2m',
          bitrate: 500_000,
          enableFd: true,
          dataBitrate: 2_000_000,
          listenOnly: true,
          mockFpsPreset: null,
          autoConnectOnProjectLoad: false,
          notes: dev.locationInfo ? `USB Location: ${dev.locationInfo}` : '',
          databaseIds: [],
        };
        connectionStore.upsertProfile(newProfile);
        setDraft(newProfile);
        setEditorOpen(true);
        onStatusMessage({
          kind: 'success',
          message: t('conn.status.savedProfile', {
            name: newProfile.name,
            bus: newProfile.busId + 1,
          }),
        });
        return;
      }

      setDraft((prev) => {
        const updated: SavedConnectionProfile = {
          ...prev,
          name: `${dev.productName || dev.vendorName} (${ch})`,
          driverFamily: 'socketcan',
          adapterChannel: ch,
          enableFd: true,
          deviceId: targetDeviceId,
        };
        return updated;
      });
      setEditorOpen(true);

      onStatusMessage({
        kind: 'info',
        message: t('conn.bar.prefilledProfile', {
          name: dev.productName || dev.vendorName,
          channel: ch,
        }),
      });
      return;
    }

    // 4. Resolve driver family
    const rawFam = (suggestedPrefix || dev.matchedFamily).toLowerCase();
    const family: DriverFamilyId =
      rawFam === 'pcan'
        ? 'pcan'
        : rawFam === 'kvaser'
          ? 'kvaser'
          : rawFam === 'vector_xl'
            ? 'vector_xl'
            : rawFam === 'slcan'
              ? 'slcan'
              : rawFam === 'socketcan'
                ? 'socketcan'
                : 'gs_usb';

    let adapterChannel = cleanChannel || '0';
    let serialPort = draft.serialPort;
    let enableFd = true;

    if (family === 'slcan') {
      const rawPort =
        cleanChannel ||
        connState.probeReport?.serialPorts[0]?.portName ||
        defaultSerialPortPlaceholder(connState.probeReport?.hostOs);
      serialPort = rawPort.startsWith('slcan:') ? rawPort.slice(6) : rawPort;
      adapterChannel = 'slcan0';
      enableFd = false;
    } else if (family === 'pcan') {
      adapterChannel = cleanChannel || PCAN_DEFAULT_CHANNEL;
    } else if (family === 'kvaser' || family === 'vector_xl') {
      adapterChannel = cleanChannel || '0';
    } else if (family === 'gs_usb') {
      adapterChannel = cleanChannel || '0';
    } else if (family === 'socketcan') {
      adapterChannel = cleanChannel || 'can0';
    }

    const targetDeviceId = resolveDeviceIdForProfile({
      driverFamily: family,
      adapterChannel,
      serialPort,
    } as SavedConnectionProfile);

    // If an existing saved profile already targets this exact deviceId, select it
    const existingMatch = connState.profiles.find((p) => p.deviceId === targetDeviceId);
    if (existingMatch) {
      connectionStore.selectProfile(existingMatch.id);
      setDraft({ ...existingMatch });
      setEditorOpen(true);
      onStatusMessage({
        kind: 'info',
        message: t('conn.bar.prefilledProfile', {
          name: existingMatch.name,
          channel: family === 'slcan' ? existingMatch.serialPort : existingMatch.adapterChannel,
        }),
      });
      return;
    }

    // If current draft profile is already live connected OR already saved with a different channel/device
    const isCurrentDraftLive = header.buses.some((b) => b.busId === draft.busId && b.connected);
    const isCurrentDraftOccupied =
      isCurrentDraftLive ||
      connState.profiles.some((p) => p.id === draft.id && p.deviceId !== targetDeviceId);

    if (isCurrentDraftOccupied) {
      const freeBus = findNextFreeBusId(connState.profiles);
      const newProfile: SavedConnectionProfile = {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `${dev.productName || dev.vendorName} (${family === 'slcan' ? serialPort : adapterChannel})`,
        busId: freeBus,
        driverFamily: family,
        deviceId: targetDeviceId,
        adapterChannel,
        serialPort,
        serialBaudRate: 1_000_000,
        serialDtrRts: true,
        bitrateProfileId: enableFd ? 'fd_500k_2m' : 'can_500k',
        bitrate: 500_000,
        enableFd,
        dataBitrate: 2_000_000,
        listenOnly: true,
        mockFpsPreset: null,
        autoConnectOnProjectLoad: false,
        notes: dev.locationInfo ? `USB Location: ${dev.locationInfo}` : '',
        databaseIds: [],
      };
      connectionStore.upsertProfile(newProfile);
      setDraft(newProfile);
      setEditorOpen(true);
      onStatusMessage({
        kind: 'success',
        message: t('conn.status.savedProfile', {
          name: newProfile.name,
          bus: newProfile.busId + 1,
        }),
      });
      return;
    }

    setDraft((prev) => {
      const updated: SavedConnectionProfile = {
        ...prev,
        name: `${dev.productName || dev.vendorName} (${family === 'slcan' ? serialPort : adapterChannel})`,
        driverFamily: family,
        adapterChannel,
        serialPort,
        enableFd,
        deviceId: targetDeviceId,
      };
      return updated;
    });
    setEditorOpen(true);

    onStatusMessage({
      kind: 'info',
      message: t('conn.bar.prefilledProfile', {
        name: dev.productName || dev.vendorName,
        channel: family === 'slcan' ? serialPort : adapterChannel,
      }),
    });
  };

  const handleQuickAttachSerialPort = (sp: SerialPortInfoDto): void => {
    const rawPort = sp.portName.trim();
    const cleanPort = rawPort.startsWith('slcan:') ? rawPort.slice(6) : rawPort;
    const targetDeviceId = `slcan:${cleanPort}`;

    const existingMatch = connState.profiles.find((p) => p.deviceId === targetDeviceId);
    if (existingMatch) {
      connectionStore.selectProfile(existingMatch.id);
      setDraft({ ...existingMatch });
      setEditorOpen(true);
      onStatusMessage({
        kind: 'info',
        message: t('conn.bar.prefilledProfile', {
          name: existingMatch.name,
          channel: cleanPort,
        }),
      });
      return;
    }

    const isCurrentDraftLive = header.buses.some((b) => b.busId === draft.busId && b.connected);
    const isCurrentDraftOccupied =
      isCurrentDraftLive ||
      connState.profiles.some(
        (p) => p.id === draft.id && (p.driverFamily !== 'slcan' || p.serialPort !== cleanPort),
      );

    if (isCurrentDraftOccupied) {
      const freeBus = findNextFreeBusId(connState.profiles);
      const newProfile: SavedConnectionProfile = {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `SLCAN (${cleanPort})`,
        busId: freeBus,
        driverFamily: 'slcan',
        deviceId: targetDeviceId,
        adapterChannel: 'slcan0',
        serialPort: cleanPort,
        serialBaudRate: 1_000_000,
        serialDtrRts: true,
        bitrateProfileId: 'can_500k',
        bitrate: 500_000,
        enableFd: false,
        dataBitrate: 500_000,
        listenOnly: true,
        mockFpsPreset: null,
        autoConnectOnProjectLoad: false,
        notes: sp.product ? `Serial: ${sp.product}` : '',
        databaseIds: [],
      };
      connectionStore.upsertProfile(newProfile);
      setDraft(newProfile);
      setEditorOpen(true);
      onStatusMessage({
        kind: 'success',
        message: t('conn.status.savedProfile', {
          name: newProfile.name,
          bus: newProfile.busId + 1,
        }),
      });
      return;
    }

    setDraft((prev) => {
      const updated: SavedConnectionProfile = {
        ...prev,
        name: `SLCAN (${cleanPort})`,
        driverFamily: 'slcan',
        serialPort: cleanPort,
        adapterChannel: 'slcan0',
        enableFd: false,
        deviceId: targetDeviceId,
      };
      return updated;
    });
    setEditorOpen(true);

    onStatusMessage({
      kind: 'info',
      message: t('conn.bar.prefilledProfile', {
        name: `SLCAN (${cleanPort})`,
        channel: cleanPort,
      }),
    });
  };

  const handleSaveDraft = (): SavedConnectionProfile | null => {
    if (draft.driverFamily === 'slcan' && draft.serialPort.trim().length === 0) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.slcanPortRequired'),
      });
      return null;
    }

    const normalized: SavedConnectionProfile = {
      ...draft,
      name: draft.name.trim() || `Bus ${draft.busId + 1} (${draft.driverFamily})`,
      serialPort: draft.serialPort.trim(),
      adapterChannel: draft.adapterChannel.trim(),
      deviceId: resolveDeviceIdForProfile(draft),
    };
    connectionStore.upsertProfile(normalized);
    setDraft(normalized);
    setEditorOpen(false);
    onStatusMessage({
      kind: 'success',
      message: t('conn.status.savedProfile', {
        name: normalized.name,
        bus: normalized.busId + 1,
      }),
    });
    return normalized;
  };

  const handleConnectOrDisconnectProfile = async (
    profile: SavedConnectionProfile,
  ): Promise<void> => {
    const liveBus = header.buses.find(
      (b) => b.busId === profile.busId && b.connected,
    );
    setBusyProfileId(profile.id);
    try {
      if (liveBus) {
        await apiDisconnectBus(profile.busId);
        telemetryStore.removeBusHealth(profile.busId);
        onStatusMessage({
          kind: 'info',
          message: t('conn.status.disconnectedBus', {
            bus: profile.busId + 1,
            channel: liveBus.channelName,
          }),
        });
      } else {
        if (
          profile.driverFamily === 'slcan' &&
          profile.serialPort.trim().length === 0
        ) {
          onStatusMessage({
            kind: 'error',
            message: t('conn.status.serialPortEmpty', { name: profile.name }),
          });
          return;
        }

        let effectiveProfile = profile;
        if (profile.driverFamily === 'mock' && profile.databaseIds.length === 0) {
          const presetIds = await ensureMockPresetDatabasesLoaded();
          connectionStore.setProfileDatabases(profile.id, presetIds);
          effectiveProfile = { ...profile, databaseIds: presetIds };
          await syncAllBusDatabasesWithBackend();
        }

        const { deviceId, config } = buildChannelConfigForProfile(effectiveProfile);
        const health = await apiConnectBus(deviceId, config);
        telemetryStore.upsertBusHealth(health);
        onStatusMessage({
          kind: 'success',
          message: t('conn.status.connectedBus', {
            bus: profile.busId + 1,
            channel: health.channelName,
            mode: health.listenOnly ? 'Listen-Only' : 'Active CAN',
          }),
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.connFailed', {
          name: profile.name,
          err: describeTxError(err),
        }),
      });
    } finally {
      setBusyProfileId(null);
    }
  };

  const handleSaveAndConnect = async (): Promise<void> => {
    const saved = handleSaveDraft();
    if (!saved) return;
    const liveBus = header.buses.find((b) => b.busId === saved.busId && b.connected);
    if (liveBus) {
      await apiDisconnectBus(saved.busId).catch(() => null);
      telemetryStore.removeBusHealth(saved.busId);
    }
    await handleConnectOrDisconnectProfile(saved);
    setEditorOpen(false);
  };

  const handleToggleArmOnBus = async (
    busId: number,
    currentArmed: boolean,
  ): Promise<void> => {
    try {
      const willArm = !currentArmed;
      const updated = await setBusTxArmed(busId, willArm);

      onStatusMessage({
        kind: willArm ? 'success' : 'info',
        message: willArm
          ? t('conn.status.txArmed', { bus: busId + 1, channel: updated.channelName })
          : t('conn.status.txDisarmed', { bus: busId + 1, channel: updated.channelName }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.setModeError', {
          err: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleDisconnectAll = async (): Promise<void> => {
    try {
      const count = await apiDisconnectAllBuses();
      telemetryStore.clearAllBuses();
      transmitStore.markAllPaused();
      onStatusMessage({
        kind: 'info',
        message: t('conn.status.disconnectedAll', { count }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.disconnectAllError', {
          err: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleCreateNewProfile = (): void => {
    const freeBus = findNextFreeBusId(connState.profiles);
    const fresh = createBlankProfile(
      freeBus,
      devices,
      connState.probeReport,
      connState.profiles,
    );
    connectionStore.upsertProfile(fresh);
    setDraft(fresh);
    setEditorOpen(true);
  };

  const handleAddMockProfile = async (): Promise<void> => {
    const freeBus = findNextFreeBusId(connState.profiles);
    const presetIds = await ensureMockPresetDatabasesLoaded();
    const fresh = createMockProfile(freeBus);
    fresh.databaseIds = presetIds;
    connectionStore.upsertProfile(fresh);
    void syncAllBusDatabasesWithBackend();
    setDraft(fresh);
    setEditorOpen(true);
    onStatusMessage({
      kind: 'info',
      message: t('conn.status.mockAdded', { name: fresh.name, bus: fresh.busId + 1 }),
    });
  };

  const handleDuplicateProfile = (prof: SavedConnectionProfile): void => {
    const nextBus = findNextFreeBusId(connState.profiles);
    let adapterChannel = prof.adapterChannel;
    let serialPort = prof.serialPort;

    if (prof.driverFamily === 'slcan') {
      const serialCandidates = serialPorts.map((s) => s.portName);
      serialPort = pickNextUnusedSerialPort(
        serialCandidates,
        connState.profiles,
        undefined,
        prof.serialPort || defaultSerialPortPlaceholder(connState.probeReport?.hostOs),
      );
    } else {
      let candidates: readonly string[] = [];
      if (prof.driverFamily === 'gs_usb') {
        candidates = familyStatusMap.get('gs_usb')?.detectedChannels.length
          ? familyStatusMap.get('gs_usb')!.detectedChannels
          : ['0', '1', '2', '3'];
      } else if (prof.driverFamily === 'pcan') {
        candidates = pcanCandidateChannels(familyStatusMap.get('pcan'));
      } else if (prof.driverFamily === 'kvaser') {
        candidates = familyStatusMap.get('kvaser')?.detectedChannels.length
          ? familyStatusMap.get('kvaser')!.detectedChannels
          : KVASER_ADAPTER_CHANNELS;
      } else if (prof.driverFamily === 'vector_xl') {
        candidates = familyStatusMap.get('vector_xl')?.detectedChannels.length
          ? familyStatusMap.get('vector_xl')!.detectedChannels
          : VECTOR_XL_ADAPTER_CHANNELS;
      } else if (prof.driverFamily === 'socketcan') {
        candidates = familyStatusMap.get('socketcan')?.detectedChannels.length
          ? familyStatusMap.get('socketcan')!.detectedChannels
          : ['can0', 'can1', 'vcan0', 'vcan1'];
      }
      if (candidates.length > 0) {
        adapterChannel = pickNextUnusedChannel(
          prof.driverFamily,
          candidates,
          connState.profiles,
          undefined,
          prof.adapterChannel,
        );
      }
    }

    const copy: SavedConnectionProfile = {
      ...prof,
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${prof.name} (Copy)`,
      busId: nextBus,
      adapterChannel,
      serialPort,
    };
    copy.deviceId = resolveDeviceIdForProfile(copy);
    connectionStore.upsertProfile(copy);
    setDraft(copy);
    setEditorOpen(true);
  };

  const serialPorts = connState.probeReport?.serialPorts ?? [];
  const usbDevices = connState.probeReport?.usbDevices ?? [];

  // Effective OS guide calculations
  const effectiveGuideOs: 'linux' | 'windows' | 'macos' =
    guideOsPreview === 'active'
      ? currentHostOs === 'windows'
        ? 'windows'
        : currentHostOs === 'macos'
          ? 'macos'
          : 'linux'
      : guideOsPreview;

  const staticRefForDriver =
    OS_DRIVER_REFERENCE[draft.driverFamily]?.[effectiveGuideOs];

  const effectiveSourceLocations: string[] =
    guideOsPreview === 'active' &&
    draftDriverStatus?.osSourceLocations &&
    draftDriverStatus.osSourceLocations.length > 0
      ? draftDriverStatus.osSourceLocations
      : staticRefForDriver?.sourceLocations ?? draftDriverStatus?.searchedPaths ?? [];

  const effectiveSetupSteps: OsSetupStepDto[] =
    guideOsPreview === 'active' &&
    draftDriverStatus?.setupSteps &&
    draftDriverStatus.setupSteps.length > 0
      ? draftDriverStatus.setupSteps
      : staticRefForDriver?.setupSteps ?? [];

  // Channel details available for the selected draft family
  const detectedChannelDetails: readonly DetectedChannelDetailDto[] = (() => {
    const seen = new Set<string>();
    return (draftDriverStatus?.channelDetails ?? []).filter((cd) => {
      if (seen.has(cd.channelId)) return false;
      seen.add(cd.channelId);
      return true;
    });
  })();
  const pcanDetected = getDetectedChannels(familyStatusMap.get('pcan'));

  const selectedChannelDetail = detectedChannelDetails.find(
    (cd) => cd.channelId === draft.adapterChannel,
  );

  const softwareOnlyBuses = header.buses.filter(
    (b) => b.connected && b.listenOnly && !b.txArmed && b.listenOnlyEnforcement === 'softwareOnly',
  );

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="flex flex-col flex-1 min-h-0 overflow-hidden select-none"
    >
      {softwareOnlyBuses.map((b) => (
        <div
          key={`sw-lo-${b.busId}`}
          role="alert"
          className="shrink-0 px-3 py-1.5 border-b border-amber-500/70 bg-amber-900/20 text-amber-200 text-[11.5px]"
        >
          {t('sec.enf.softwareWarn', { bus: b.busId + 1, channel: b.channelName })}{' '}
          {t('sec.hwlo.softwareHint')}
        </div>
      ))}
      {/* ==================================================================== */}
      {/* 1. TOP HOST OS & DRIVER DIAGNOSTIC STRIP + EXPANDABLE INSPECTOR      */}
      {/* ==================================================================== */}
      <section
        style={{ borderBottom: '1px solid var(--border-strong)' }}
        className="shrink-0"
      >
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderBottom:
              driverDetailsOpen ||
              serialPorts.length > 0 ||
              usbDevices.length > 0
                ? '1px solid var(--border-grid)'
                : 'none',
          }}
          className="min-h-[38px] py-1.5 px-3 flex items-center justify-between gap-2 text-[12px] flex-wrap"
        >
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {/* Host OS Badge */}
            <div
              className="flex items-center gap-1.5 font-mono text-[11px] px-2 py-0.5 border"
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
              }}
              title={
                hostEnv
                  ? `${hostEnv.os.toUpperCase()} ${hostEnv.arch} (${hostEnv.osRelease})\nNative Stacks: ${hostEnv.nativeStacks.join(', ')}\n${hostEnv.osNotes.join('\n')}`
                  : `Host OS: ${connState.probeReport?.hostOs ?? 'Unknown'}`
              }
            >
              <Laptop className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span className="text-[var(--text-muted)] font-sans">
                {t('conn.bar.osBadge')}
              </span>
              <span className="font-bold text-[var(--text-primary)]">
                {hostEnv
                  ? hostEnv.isWsl
                    ? 'LINUX (WSL2)'
                    : hostEnv.os === 'linux'
                      ? 'LINUX NATIVE'
                      : hostEnv.os === 'windows'
                        ? `WINDOWS (${hostEnv.arch === 'x86_64' ? 'x64' : hostEnv.arch})`
                        : hostEnv.os === 'macos'
                          ? `MACOS (IOKit · ${hostEnv.arch})`
                          : `${hostEnv.os.toUpperCase()} (${hostEnv.arch})`
                  : (connState.probeReport?.hostOs ?? 'HOST').toUpperCase()}
              </span>
              {hostEnv?.isWsl && (
                <span className="bg-sky-950/80 text-sky-300 border border-sky-500/50 px-1 text-[10px] font-semibold">
                  {t('conn.bar.wslBadge')}
                </span>
              )}
              {hostEnv?.os === 'linux' && (
                <span
                  className={
                    hostEnv.udevRulesPresent
                      ? 'text-emerald-400 border border-emerald-500/40 px-1 text-[10px]'
                      : 'text-amber-400 border border-amber-500/40 px-1 text-[10px]'
                  }
                  title={
                    hostEnv.udevRulesPresent
                      ? t('conn.bar.udevOk')
                      : t('conn.bar.udevMissing')
                  }
                >
                  {hostEnv.udevRulesPresent ? 'udev ✓' : 'udev ?'}
                </span>
              )}
            </div>

            {/* Real-time Hardware Auto-Watch Badge */}
            <div
              className="flex items-center gap-1.5 font-mono text-[10px] px-2 py-0.5 border border-emerald-500/40 bg-emerald-950/40 text-emerald-300 shrink-0"
              title={t('conn.bar.autoWatchHotplug')}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-semibold uppercase tracking-wider">
                {t('conn.bar.autoWatchHotplug')}
              </span>
            </div>

            <span className="text-[var(--text-muted)] font-mono text-[11px]">|</span>

            <Cpu className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
            <span className="font-semibold text-[var(--text-secondary)] shrink-0">
              {t('conn.bar.drivers')}
            </span>

            {(connState.probeReport?.families ?? []).length === 0 ? (
              <span className="text-[var(--text-muted)] truncate">
                {probing ? t('conn.bar.scanningDrivers') : t('conn.bar.notScanned')}
              </span>
            ) : (
              <div className="flex items-center gap-2.5 font-mono text-[12px] shrink-0 flex-wrap">
                {connState.probeReport?.families.map((fam, idx) => {
                  const isInstalled = fam.installed;
                  const isOsSupported = fam.osSupported !== false;
                  const isHwPresent = Boolean(
                    fam.hardwarePresent && !fam.installed,
                  );

                  let statusBadge: React.ReactNode;
                  let pillClass = 'text-[var(--text-muted)]';
                  let tooltip = `${fam.displayName}: ${fam.installHint}`;

                  if (isInstalled) {
                    statusBadge = (
                      <span className="text-emerald-500 font-semibold">✓</span>
                    );
                    pillClass = 'text-[var(--text-primary)]';
                    tooltip = `${fam.displayName}: ${fam.detectedLibraryOrModule ?? t('conn.status.ready')}`;
                  } else if (!isOsSupported) {
                    statusBadge = (
                      <span className="text-[var(--text-muted)] text-[10px] opacity-70">
                        N/A
                      </span>
                    );
                    pillClass = 'text-[var(--text-muted)] opacity-60';
                    tooltip = `${fam.displayName}: ${t('conn.status.osUnsupported')}`;
                  } else if (isHwPresent) {
                    statusBadge = (
                      <span className="text-amber-400 font-bold bg-amber-950/70 border border-amber-500/60 px-1 text-[10px]">
                        HW!
                      </span>
                    );
                    pillClass = 'text-amber-300 font-semibold';
                    tooltip = `${fam.displayName}: ${t('conn.status.hwPresentNeedsDriver')} — ${fam.installHint}`;
                  } else {
                    statusBadge = (
                      <span className="text-[var(--text-muted)]">—</span>
                    );
                    pillClass = 'text-[var(--text-muted)]';
                  }

                  return (
                    <React.Fragment key={fam.familyId}>
                      {idx > 0 && (
                        <span className="text-[var(--text-muted)]">·</span>
                      )}
                      <span
                        title={tooltip}
                        className={`inline-flex items-center gap-1 ${pillClass}`}
                      >
                        <span>{fam.familyId}</span>
                        {statusBadge}
                      </span>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setDriverDetailsOpen((v) => !v)}
              style={{
                backgroundColor: driverDetailsOpen
                  ? 'var(--bg-header)'
                  : 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-secondary)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] font-medium hover:text-[var(--text-primary)] cursor-pointer"
            >
              {driverDetailsOpen ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              <span>{t('conn.bar.driverDetails')}</span>
            </button>

            <button
              type="button"
              disabled={probing}
              onClick={() => void runDriverProbe(false)}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] font-medium hover:border-[var(--text-secondary)] cursor-pointer"
              title={t('conn.bar.rescanTitle')}
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-[var(--text-secondary)] ${
                  probing ? 'animate-spin' : ''
                }`}
              />
              <span>{t('conn.bar.rescan')}</span>
            </button>
          </div>
        </div>

        {/* Quick-Attach Hardware Strip (USB-CAN + Serial Ports) */}
        {(usbDevices.length > 0 || serialPorts.length > 0) && (
          <div
            style={{
              backgroundColor: 'var(--bg-row-alt)',
              borderBottom: driverDetailsOpen ? '1px solid var(--border-grid)' : 'none',
            }}
            className="min-h-[36px] px-3 py-1.5 flex flex-wrap items-center gap-2 text-[12px]"
          >
            <span className="font-semibold text-[var(--text-secondary)] flex items-center gap-1.5 shrink-0">
              <Plug className="w-3.5 h-3.5 text-emerald-400" />
              <span>{t('conn.bar.quickAttachTitle')}</span>
            </span>

            {/* USB-CAN Device Chips */}
            {usbDevices.map((dev, idx) => {
              const isDfu = dev.matchedFamily === 'dfu_bootloader';
              const isWinUsbNeeded =
                dev.accessStatus.toLowerCase().includes('winusb') ||
                dev.accessStatus.toLowerCase().includes('zadig');

              return (
                <button
                  key={`usb-${idx}-${dev.vidPid}-${dev.suggestedChannel ?? ''}-${dev.locationInfo ?? ''}`}
                  type="button"
                  onClick={() => handleQuickAttachUsbDevice(dev)}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: isDfu
                      ? '#f59e0b'
                      : dev.driverBound
                        ? '#10b981'
                        : 'var(--border-strong)',
                  }}
                  className="h-[28px] px-2.5 border font-mono text-[12px] hover:border-sky-400 cursor-pointer flex items-center gap-1.5 text-left"
                  title={`VID:PID ${dev.vidPid} · Vendor: ${dev.vendorName} · Family: ${dev.matchedFamily}${dev.suggestedChannel ? ` · Channel: ${dev.suggestedChannel}` : ''}${dev.locationInfo ? ` · Loc: ${dev.locationInfo}` : ''}${dev.serialNumber ? ` · S/N: ${dev.serialNumber}` : ''}\nStatus: ${dev.accessStatus}`}
                >
                  <Usb className="w-3 h-3 text-sky-400 shrink-0" />
                  <span className="font-semibold text-[var(--text-primary)]">
                    {dev.vidPid}
                  </span>
                  {dev.suggestedChannel && (
                    <span className="px-1 py-0.5 bg-sky-950/70 text-sky-300 border border-sky-500/40 text-[10px] font-mono font-semibold shrink-0">
                      {dev.suggestedChannel}
                    </span>
                  )}
                  <span className="text-[var(--text-secondary)] truncate max-w-[140px]">
                    {dev.productName || dev.vendorName}
                  </span>
                  {dev.locationInfo ? (
                    <span
                      className="text-[var(--text-muted)] text-[10px] font-mono shrink-0"
                      title={`Location: ${dev.locationInfo}`}
                    >
                      [{dev.locationInfo}]
                    </span>
                  ) : dev.serialNumber ? (
                    <span
                      className="text-[var(--text-muted)] text-[10px] font-mono shrink-0"
                      title={`S/N: ${dev.serialNumber}`}
                    >
                      [#{dev.serialNumber}]
                    </span>
                  ) : null}
                  <span
                    className={
                      isDfu
                        ? 'text-amber-400 font-bold text-[10px] border border-amber-500/50 px-1 shrink-0'
                        : dev.driverBound
                          ? 'text-emerald-400 font-bold text-[10px] border border-emerald-500/50 px-1 shrink-0'
                          : isWinUsbNeeded
                            ? 'text-amber-300 font-bold text-[10px] border border-amber-500/50 px-1 shrink-0'
                            : 'text-[var(--text-muted)] text-[10px] shrink-0'
                    }
                  >
                    {isDfu
                      ? 'DFU'
                      : dev.driverBound
                        ? 'READY'
                        : isWinUsbNeeded
                          ? 'WINUSB REQ'
                          : dev.accessStatus.toUpperCase()}
                  </span>
                </button>
              );
            })}

            {/* Serial Port Chips */}
            {serialPorts.map((sp) => (
              <button
                key={`sp-${sp.portName}`}
                type="button"
                onClick={() => handleQuickAttachSerialPort(sp)}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[28px] px-2.5 border font-mono text-[12px] hover:border-sky-400 cursor-pointer flex items-center gap-1"
                title={t('conn.bar.selectPortTitle', { port: sp.portName })}
              >
                <Plug className="w-3 h-3 text-sky-400 shrink-0" />
                <span className="font-semibold text-[var(--text-primary)]">
                  {sp.portName}
                </span>
                {sp.product && (
                  <span className="text-[var(--text-secondary)] truncate max-w-[140px]">
                    · {sp.product}
                  </span>
                )}
                {sp.vidPid && (
                  <span className="text-[var(--text-muted)]">[{sp.vidPid}]</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Expanded Driver Details Drawer */}
        {driverDetailsOpen && (
          <div className="max-h-[300px] overflow-y-auto p-3 space-y-3 bg-[var(--bg-panel)]">
            {/* Host Environment Notes & Stacks Banner */}
            {hostEnv && (
              <div
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="p-2.5 border text-[11.5px] space-y-2"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[var(--text-primary)]">
                      {hostEnv.os.toUpperCase()} {hostEnv.arch}
                    </span>
                    <span className="text-[var(--text-muted)] font-mono">
                      ({hostEnv.osRelease})
                    </span>
                    {hostEnv.nativeStacks.map((stack) => (
                      <span
                        key={stack}
                        className="px-1.5 py-0.2 border border-sky-500/40 bg-sky-950/30 text-sky-300 font-mono text-[10.5px]"
                      >
                        {stack}
                      </span>
                    ))}
                  </div>

                  {/* OS Switcher Tabs */}
                  <div className="flex items-center gap-1 font-mono text-[11px]">
                    <span className="text-[var(--text-muted)] mr-1">
                      {t('conn.guide.previewOs')}
                    </span>
                    {(['host', 'linux', 'windows', 'macos'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setDrawerOsTab(tab)}
                        style={{
                          backgroundColor:
                            drawerOsTab === tab
                              ? 'var(--bg-header)'
                              : 'var(--bg-panel)',
                          borderColor:
                            drawerOsTab === tab
                              ? '#38bdf8'
                              : 'var(--border-strong)',
                          color:
                            drawerOsTab === tab
                              ? '#38bdf8'
                              : 'var(--text-secondary)',
                        }}
                        className="px-2 py-0.5 border text-[10.5px] uppercase font-medium cursor-pointer"
                      >
                        {tab === 'host'
                          ? `${t('conn.guide.activeHost')} (${hostEnv.os})`
                          : tab}
                      </button>
                    ))}
                  </div>
                </div>

                {hostEnv.osNotes.length > 0 && (
                  <div className="space-y-1 text-[var(--text-secondary)] font-mono text-[11px]">
                    {hostEnv.osNotes.map((note, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <span className="text-sky-400 shrink-0">•</span>
                        <span>{note}</span>
                      </div>
                    ))}
                  </div>
                )}

                {hostEnv.serialPermissionHint && (
                  <div className="p-1.5 bg-amber-950/30 border border-amber-500/50 text-amber-300 flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px]">
                      {hostEnv.serialPermissionHint}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard(
                          hostEnv.serialPermissionHint!,
                          'serialPermHint',
                        )
                      }
                      className="px-1.5 py-0.5 border border-amber-500/60 bg-amber-950/60 hover:bg-amber-900/60 text-[10px] flex items-center gap-1 shrink-0 cursor-pointer"
                    >
                      {copiedKey === 'serialPermHint' ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      <span>
                        {copiedKey === 'serialPermHint'
                          ? t('conn.guide.copied')
                          : t('conn.guide.copyCmd')}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Driver Families Table */}
            <div className="border border-[var(--border-strong)] overflow-hidden">
              <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums text-[12px]">
                <colgroup>
                  <col style={{ width: '180px' }} />
                  <col style={{ width: '130px' }} />
                  <col style={{ width: '220px' }} />
                  <col style={{ width: '160px' }} />
                  <col style={{ width: '260px' }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th className="font-sans">{t('conn.table.thDriverFamily')}</th>
                    <th className="font-sans">{t('conn.table.thStatus')}</th>
                    <th>{t('conn.table.thLibrary')}</th>
                    <th>{t('conn.table.thDetectedChannels')}</th>
                    <th>{t('conn.table.thOsSources')}</th>
                    <th className="font-sans">{t('conn.table.thInstallHint')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(connState.probeReport?.families ?? []).map((fam) => {
                    const effectiveOsForDrawer: 'linux' | 'windows' | 'macos' =
                      drawerOsTab === 'host'
                        ? currentHostOs === 'windows'
                          ? 'windows'
                          : currentHostOs === 'macos'
                            ? 'macos'
                            : 'linux'
                        : drawerOsTab;

                    const ref =
                      OS_DRIVER_REFERENCE[fam.familyId as DriverFamilyId]?.[
                        effectiveOsForDrawer
                      ];

                    const osSources =
                      drawerOsTab === 'host' &&
                      fam.osSourceLocations &&
                      fam.osSourceLocations.length > 0
                        ? fam.osSourceLocations
                        : ref?.sourceLocations ?? fam.searchedPaths;

                    return (
                      <tr key={fam.familyId}>
                        <td>
                          <div className="pcan-cell font-sans font-semibold text-[12px]">
                            <span className="truncate">{fam.displayName}</span>
                          </div>
                        </td>
                        <td>
                          <div className="pcan-cell font-sans text-[12px]">
                            {fam.installed ? (
                              <span className="inline-flex items-center gap-1 text-emerald-500 font-medium text-[12px]">
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">
                                  {fam.statusLabel || t('conn.status.ready')}
                                </span>
                              </span>
                            ) : fam.osSupported === false ? (
                              <span className="inline-flex items-center gap-1 text-[var(--text-muted)] opacity-70 text-[12px]">
                                <span className="truncate">
                                  {t('conn.status.osUnsupported')}
                                </span>
                              </span>
                            ) : fam.hardwarePresent ? (
                              <span className="inline-flex items-center gap-1 text-amber-400 font-semibold text-[12px]">
                                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">
                                  {t('conn.status.hwPresentNeedsDriver')}
                                </span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[var(--text-muted)] text-[12px]">
                                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">
                                  {fam.statusLabel || t('conn.status.notInstalled')}
                                </span>
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="pcan-cell text-[12px] text-[var(--text-secondary)] space-y-0.5">
                            <span className="truncate block">
                              {fam.detectedLibraryOrModule ?? '—'}
                            </span>
                            {fam.architectureNote && (
                              <span className="inline-block bg-amber-950/60 border border-amber-500/50 text-amber-300 text-[10px] px-1 font-sans">
                                {fam.architectureNote}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div
                            className="pcan-cell text-[12px]"
                            title={Array.from(new Set(fam.detectedChannels)).join(', ')}
                          >
                            <span className="truncate">
                              {fam.detectedChannels.length > 0
                                ? Array.from(new Set(fam.detectedChannels)).join(', ')
                                : '—'}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div
                            className="pcan-cell text-[11px] text-[var(--text-secondary)] select-all font-mono"
                            title={osSources.join('\n')}
                          >
                            <span className="truncate">
                              {osSources[0] ?? '—'}
                              {osSources.length > 1 ? ` (+${osSources.length - 1})` : ''}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div
                            className="pcan-cell font-sans text-[12px] text-[var(--text-secondary)]"
                            title={fam.installHint}
                          >
                            <span className="truncate">{fam.installHint}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* ==================================================================== */}
      {/* 2. MAIN WORKSPACE: SAVED PROFILES TABLE (LEFT) + EDITOR (RIGHT)      */}
      {/* ==================================================================== */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* LEFT: Saved Connection Profiles */}
        <div
          style={{ borderRight: editorOpen ? '1px solid var(--border-strong)' : 'none' }}
          className="flex flex-col flex-1 min-w-0 min-h-0"
        >
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderBottom: '1px solid var(--border-strong)',
            }}
            className="shrink-0 min-h-[38px] px-3 py-1 flex items-center justify-between gap-2 text-[12px] flex-wrap"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleCreateNewProfile}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium text-[12px] hover:border-[var(--text-secondary)] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>{t('conn.btn.newProfile')}</span>
              </button>

              <button
                type="button"
                disabled={!header.buses.some((b) => b.connected)}
                onClick={() => void handleDisconnectAll()}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium text-[12px] hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
              >
                <PlugZap className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>{t('conn.btn.disconnectAll')}</span>
              </button>
              <button
                type="button"
                onClick={handleAddMockProfile}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-secondary)',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1 text-[11.5px] font-mono hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer"
                title={t('conn.btn.addSimulatorTitle')}
              >
                <span>{t('conn.btn.addSimulator')}</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {!editorOpen && connState.profiles.length > 0 && (
                <button
                  type="button"
                  onClick={() => setEditorOpen(true)}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-secondary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium text-[12px] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer"
                  title={t('conn.btn.editTitle')}
                >
                  <Pencil className="w-3.5 h-3.5 text-sky-400" />
                  <span>{t('conn.editor.title')}</span>
                </button>
              )}
              <span className="text-[var(--text-muted)] text-[12px]">
                {t('conn.bar.profilesCount', { count: connState.profiles.length })}
              </span>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
              <colgroup>
                <col style={{ width: '36px' }} />
                <col style={{ width: '54px' }} />
                <col />
                <col style={{ width: '92px' }} />
                <col style={{ width: '136px' }} />
                <col style={{ width: '104px' }} />
                <col style={{ width: '92px' }} />
                <col style={{ width: '84px' }} />
                <col style={{ width: '88px' }} />
                <col style={{ width: '192px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="text-center font-sans" title={t('conn.th.onTitle')}>
                    {t('conn.th.on')}
                  </th>
                  <th>{t('conn.th.bus')}</th>
                  <th className="font-sans">{t('conn.th.profileName')}</th>
                  <th className="font-sans">{t('conn.th.driver')}</th>
                  <th>{t('conn.th.portChannel')}</th>
                  <th>{t('conn.th.bitrateFd')}</th>
                  <th className="font-sans">{t('conn.th.safety')}</th>
                  <th className="font-sans">{t('conn.th.hostLib')}</th>
                  <th className="font-sans">{t('conn.th.liveStatus')}</th>
                  <th className="font-sans">{t('conn.th.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {connState.profiles.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-0">
                      <div className="p-8 flex flex-col items-center justify-center text-center gap-3 bg-[var(--bg-panel)]">
                        <div className="w-12 h-12 rounded border border-[var(--border-strong)] bg-[var(--bg-toolbar)] flex items-center justify-center text-cyan-400">
                          <Cpu className="w-6 h-6" />
                        </div>
                        <div>
                          <div className="font-semibold text-[14px] text-[var(--text-primary)] font-sans">
                            {t('conn.empty.title')}
                          </div>
                          <div className="text-[12px] text-[var(--text-secondary)] mt-1.5 max-w-md font-sans leading-relaxed">
                            {t('conn.empty.desc')}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2.5 mt-2.5">
                          <button
                            type="button"
                            onClick={handleCreateNewProfile}
                            className="h-[30px] px-3.5 border border-emerald-500/60 bg-emerald-950/40 text-emerald-300 rounded font-medium text-[12px] hover:bg-emerald-900/50 cursor-pointer flex items-center gap-1.5"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>{t('conn.empty.addConnBtn')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleAddMockProfile}
                            className="h-[30px] px-3.5 border border-cyan-500/40 bg-cyan-950/30 text-cyan-300 rounded text-[12px] hover:bg-cyan-900/40 cursor-pointer flex items-center gap-1.5"
                            title={t('conn.btn.addSimulatorTitle')}
                          >
                            <Cpu className="w-3.5 h-3.5" />
                            <span>{t('conn.empty.addSimBtn')}</span>
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  connState.profiles.map((prof) => {
                    const isSelected = prof.id === connState.selectedProfileId;
                    const famStatus = familyStatusMap.get(prof.driverFamily);
                    const liveBus = header.buses.find(
                      (b) => b.busId === prof.busId && b.connected,
                    );
                    const portOrChan =
                      prof.driverFamily === 'slcan'
                        ? `${prof.serialPort || 'Unset'} @${Math.round(prof.serialBaudRate / 1000)}k`
                        : prof.adapterChannel || prof.deviceId;
                    const timingLabel =
                      prof.enableFd && prof.driverFamily !== 'slcan'
                        ? `${formatBitrateShort(prof.bitrate)}/${formatBitrateShort(prof.dataBitrate)} FD`
                        : `${formatBitrateShort(prof.bitrate)} CC`;

                    return (
                      <tr
                        key={prof.id}
                        onClick={() => {
                          connectionStore.selectProfile(prof.id);
                          setDraft({ ...prof });
                        }}
                        onDoubleClick={() => {
                          connectionStore.selectProfile(prof.id);
                          setDraft({ ...prof });
                          setEditorOpen(true);
                        }}
                        style={{
                          backgroundColor: isSelected
                            ? 'var(--bg-row-selected)'
                            : 'var(--bg-panel)',
                        }}
                        className="hover:!bg-[var(--bg-row-hover)] cursor-pointer text-[12px]"
                      >
                        {/* Checkbox toggle connection */}
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="pcan-cell pcan-cell-center">
                            <input
                              type="checkbox"
                              checked={Boolean(liveBus)}
                              disabled={busyProfileId === prof.id}
                              onChange={() =>
                                void handleConnectOrDisconnectProfile(prof)
                              }
                              className="accent-emerald-600 cursor-pointer h-4 w-4"
                              title={
                                Boolean(liveBus)
                                  ? t('conn.row.connectedTooltip', {
                                      bus: prof.busId + 1,
                                    })
                                  : t('conn.row.disconnectedTooltip', {
                                      bus: prof.busId + 1,
                                    })
                              }
                            />
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell font-semibold text-[12px]">
                            Bus {prof.busId + 1}
                          </div>
                        </td>

                        <td>
                          <div
                            className="pcan-cell font-sans font-medium text-[12px]"
                            title={prof.notes || prof.name}
                          >
                            <span className="truncate">{prof.name}</span>
                            {(() => {
                              const bound = prof.databaseIds
                                .map(
                                  (id) =>
                                    dbCatalog.find((d) => d.id === id)?.fileName,
                                )
                                .filter((n): n is string => Boolean(n));
                              return (
                                <span
                                  className="ml-1.5 shrink-0 truncate max-w-[180px] border px-1.5 py-0.5 font-mono text-[11px]"
                                  style={{
                                    borderColor:
                                      bound.length > 0
                                        ? 'var(--border-strong)'
                                        : 'var(--status-warn)',
                                    color:
                                      bound.length > 0
                                        ? 'var(--text-secondary)'
                                        : 'var(--status-warn)',
                                  }}
                                  title={
                                    bound.length > 0
                                      ? bound.join(', ')
                                      : t('conn.row.rawHexTooltip')
                                  }
                                >
                                  {bound.length === 0
                                    ? t('conn.row.rawHexBadge')
                                    : bound.length === 1
                                      ? bound[0]
                                      : t('conn.row.dbCountBadge', {
                                          count: bound.length,
                                        })}
                                </span>
                              );
                            })()}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell font-mono text-[12px] uppercase text-[var(--text-secondary)]">
                            {prof.driverFamily}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell text-[12px]" title={portOrChan}>
                            <span className="truncate">{portOrChan}</span>
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell text-[12px]">{timingLabel}</div>
                        </td>

                        <td>
                          <div className="pcan-cell font-sans text-[12px]">
                            {prof.listenOnly ? (
                              <span className="text-emerald-500 font-medium">
                                {t('conn.row.listenOnly')}
                              </span>
                            ) : (
                              <span className="text-amber-500 font-semibold">
                                {t('conn.row.activeCan')}
                              </span>
                            )}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell font-sans text-[12px]">
                            {famStatus === undefined ? (
                              <span className="text-[var(--text-muted)]">—</span>
                            ) : famStatus.installed ? (
                              <span className="text-emerald-500 font-semibold">
                                {t('conn.status.ready')}
                              </span>
                            ) : famStatus.osSupported === false ? (
                              <span className="text-[var(--text-muted)] opacity-60">
                                N/A
                              </span>
                            ) : (
                              <span
                                className="text-amber-500 font-semibold"
                                title={famStatus.installHint}
                              >
                                {t('conn.row.missing')}
                              </span>
                            )}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell gap-1.5">
                            <BusStateBadge
                              busState={liveBus?.busState ?? 'offline'}
                              connected={Boolean(liveBus?.connected)}
                              listenOnly={liveBus?.listenOnly}
                              txArmed={liveBus?.txArmed}
                              txErrorCount={liveBus?.txErrorCount ?? 0}
                              rxErrorCount={liveBus?.rxErrorCount ?? 0}
                              compact
                            />
                            <EnforcementBadge kind={liveBus?.listenOnlyEnforcement ?? null} />
                          </div>
                        </td>

                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="pcan-cell gap-1.5 font-sans">
                            <button
                              type="button"
                              disabled={busyProfileId === prof.id}
                              onClick={() =>
                                void handleConnectOrDisconnectProfile(prof)
                              }
                              style={{
                                backgroundColor: liveBus
                                  ? 'rgba(220, 38, 38, 0.14)'
                                  : 'rgba(16, 185, 129, 0.16)',
                                borderColor: liveBus ? '#dc2626' : '#10b981',
                              }}
                              className="h-[26px] px-2.5 border text-[11.5px] font-semibold cursor-pointer"
                            >
                              {liveBus
                                ? t('conn.btn.disconnect')
                                : t('conn.btn.connect')}
                            </button>

                            {liveBus && !liveBus.listenOnly && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleToggleArmOnBus(
                                    prof.busId,
                                    liveBus.txArmed,
                                  )
                                }
                                style={{
                                  backgroundColor: liveBus.txArmed
                                    ? 'rgba(245, 158, 11, 0.2)'
                                    : 'var(--bg-toolbar)',
                                  borderColor: liveBus.txArmed
                                    ? '#f59e0b'
                                    : 'var(--border-strong)',
                                }}
                                className="h-[26px] px-2 border text-[11.5px] cursor-pointer"
                                title={t('conn.btn.armDisarmTitle')}
                              >
                                <Unlock className="w-3 h-3 inline text-amber-500" />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                connectionStore.selectProfile(prof.id);
                                setDraft({ ...prof });
                                setEditorOpen(true);
                              }}
                              style={{
                                backgroundColor: 'var(--bg-toolbar)',
                                borderColor: 'var(--border-strong)',
                              }}
                              className="h-[26px] px-2 border text-[11.5px] cursor-pointer hover:border-sky-500/60"
                              title={t('conn.btn.editTitle')}
                            >
                              <Pencil className="w-3 h-3 text-sky-400" />
                            </button>

                            <button
                              type="button"
                              onClick={() => handleDuplicateProfile(prof)}
                              style={{
                                backgroundColor: 'var(--bg-toolbar)',
                                borderColor: 'var(--border-strong)',
                              }}
                              className="h-[26px] px-2 border text-[11.5px] cursor-pointer"
                              title={t('conn.btn.duplicateTitle')}
                            >
                              <Copy className="w-3 h-3" />
                            </button>

                            {connState.profiles.length > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  connectionStore.removeProfile(prof.id)
                                }
                                style={{
                                  backgroundColor: 'var(--bg-toolbar)',
                                  borderColor: 'var(--border-strong)',
                                }}
                                className="h-[26px] px-2 border text-[11.5px] text-[var(--text-secondary)] hover:text-red-400 cursor-pointer"
                                title={t('conn.btn.deleteTitle')}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT: Connection Profile Editor */}
        {editorOpen && (
          <aside className="w-[400px] lg:w-[440px] xl:w-[480px] shrink-0 flex flex-col min-h-0 overflow-hidden">
            <div
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="shrink-0 min-h-[38px] px-3 py-1 flex items-center justify-between text-[12px] flex-wrap gap-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-[var(--text-primary)]">
                  {t('conn.editor.title')}
                </span>
                <span className="font-mono text-[11px] text-[var(--text-muted)] truncate">
                  {resolveDeviceIdForProfile(draft)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="h-[24px] px-2 text-[11px] border border-[var(--border-strong)] bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-slate-500 flex items-center gap-1 cursor-pointer rounded-xs shrink-0"
                title={t('conn.editor.close')}
              >
                <X className="w-3.5 h-3.5" />
                <span>{t('conn.editor.close')}</span>
              </button>
            </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-[12px]">
            {/* Profile Name & Target Bus */}
            <div className="grid grid-cols-[1fr_100px] gap-2.5">
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.profileName')}
                </label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, name: e.target.value }))
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2.5 border text-[12px] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.busSlot')}
                </label>
                <div className="flex items-center gap-1.5">
                  <select
                    aria-label={t('conn.editor.busSlot')}
                    value={draft.busId}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        busId: clampBusId(Number(e.target.value)),
                      }))
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="flex-1 min-w-0 h-[30px] px-1.5 border font-mono tabular-nums text-[12px]"
                  >
                    {Array.from(
                      {
                        length:
                          Math.min(
                            MAX_BUS_ID,
                            Math.max(15, maxUsedBusId + 4, draft.busId + 2),
                          ) + 1,
                      },
                      (_, idx) => (
                        <option key={idx} value={idx}>
                          Bus {idx + 1}
                        </option>
                      ),
                    )}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={MAX_BUS_ID + 1}
                    value={draft.busId + 1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (Number.isFinite(val)) {
                        setDraft((p) => ({ ...p, busId: clampBusId(val - 1) }));
                      }
                    }}
                    title="Direct Bus Number (1..256)"
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-14 h-[30px] px-1 border font-mono text-center text-[12px] focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Hardware Driver Family */}
            <div>
              <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                {t('conn.editor.driverFamily')}
              </label>
              <select
                aria-label={t('conn.editor.driverFamily')}
                value={draft.driverFamily}
                onChange={(e) =>
                  handleSelectDriverFamily(e.target.value as DriverFamilyId)
                }
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[30px] px-2 border text-[12px]"
              >
                {DRIVER_FAMILY_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            {/* Live Driver Readiness for Selected Family */}
            {draftDriverStatus &&
              (draftDriverStatus.installed ? (
                <div className="flex items-center justify-between text-[12px] text-[var(--text-secondary)] font-mono">
                  <span>
                    <span className="text-emerald-500 mr-1.5 font-bold">✓</span>
                    {draftDriverStatus.detectedLibraryOrModule ??
                      draftDriverStatus.displayName}
                  </span>
                </div>
              ) : draftDriverStatus.osSupported === false ? (
                <div
                  style={{
                    backgroundColor: 'var(--bg-row-alt)',
                    borderColor: 'var(--border-grid)',
                  }}
                  className="p-2 border text-[11.5px] text-[var(--text-muted)]"
                >
                  <span className="font-semibold">
                    {t('conn.status.osUnsupported')}
                  </span>
                  <div className="text-[11px] mt-0.5">{draftDriverStatus.installHint}</div>
                </div>
              ) : draftDriverStatus.hardwarePresent ? (
                <div
                  style={{
                    backgroundColor: 'var(--bg-row-alt)',
                    borderColor: 'rgba(245, 158, 11, 0.6)',
                  }}
                  className="p-2 border text-[12px] space-y-1"
                >
                  <div className="font-semibold text-amber-400 flex items-center gap-1">
                    <TriangleAlert className="w-3.5 h-3.5" />
                    <span>{t('conn.status.hwPresentNeedsDriver')}</span>
                  </div>
                  <div className="text-[var(--text-secondary)] leading-snug text-[11px]">
                    {draftDriverStatus.installHint}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    backgroundColor: 'var(--bg-row-alt)',
                    borderColor: 'rgba(217, 155, 38, 0.55)',
                  }}
                  className="p-2.5 border text-[12px] space-y-1"
                >
                  <div className="font-semibold text-amber-400">
                    {t('conn.editor.driverNotInstalled', {
                      name: draftDriverStatus.displayName,
                    })}
                  </div>
                  <div className="text-[var(--text-secondary)] leading-snug text-[11.5px]">
                    {draftDriverStatus.installHint}
                  </div>
                </div>
              ))}

            {/* ============================================================== */}
            {/* DYNAMIC DETECTED HARDWARE CHANNELS SELECTOR                   */}
            {/* ============================================================== */}
            {detectedChannelDetails.length > 0 && (
              <div className="space-y-1.5">
                <label className="block text-[var(--text-secondary)] mb-1 font-medium flex items-center justify-between">
                  <span>
                    {t('conn.editor.detectedChannels')} (
                    {detectedChannelDetails.length})
                  </span>
                  <span className="font-mono text-[10px] text-sky-400">
                    Live Subsystem
                  </span>
                </label>
                <select
                  value={
                    detectedChannelDetails.some(
                      (cd) => cd.channelId === draft.adapterChannel,
                    )
                      ? draft.adapterChannel
                      : ''
                  }
                  onChange={(e) => {
                    const selected = detectedChannelDetails.find(
                      (cd) => cd.channelId === e.target.value,
                    );
                    if (selected) {
                      setDraft((p) => {
                        const updated: SavedConnectionProfile = {
                          ...p,
                          adapterChannel: selected.channelId,
                          enableFd: selected.supportsFd ? p.enableFd : false,
                        };
                        updated.deviceId = resolveDeviceIdForProfile(updated);
                        return updated;
                      });
                    }
                  }}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2 border font-mono text-[12px]"
                >
                  <option value="">
                    {t('conn.editor.chooseDetectedChannel')}
                  </option>
                  {detectedChannelDetails.map((cd) => (
                    <option key={cd.channelId} value={cd.channelId}>
                      {cd.channelId} [{cd.state.toUpperCase()}] ·{' '}
                      {cd.supportsFd ? 'CAN-FD' : 'CC'}{' '}
                      {cd.mtu ? `(MTU ${cd.mtu})` : ''}{' '}
                      {cd.kernelOrUsbDriver ? `· ${cd.kernelOrUsbDriver}` : ''}
                    </option>
                  ))}
                </select>

                {/* Hint Command for Selected Channel */}
                {selectedChannelDetail?.hintCommand && (
                  <div
                    style={{
                      backgroundColor: 'var(--bg-row-alt)',
                      borderColor: 'rgba(56, 189, 248, 0.4)',
                    }}
                    className="p-2 border font-mono text-[11px] space-y-1.5"
                  >
                    <div className="flex items-center justify-between text-[var(--text-secondary)]">
                      <span className="font-sans font-medium text-sky-400 flex items-center gap-1">
                        <Terminal className="w-3.5 h-3.5" />
                        {t('conn.editor.runHintCmd')}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            selectedChannelDetail.hintCommand!,
                            'hintCmd',
                          )
                        }
                        className="px-2 py-0.5 border border-sky-500/50 bg-sky-950/40 text-sky-300 hover:bg-sky-900/50 flex items-center gap-1 cursor-pointer text-[10px]"
                      >
                        {copiedKey === 'hintCmd' ? (
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>
                          {copiedKey === 'hintCmd'
                            ? t('conn.guide.copied')
                            : t('conn.editor.copyHintCmd')}
                        </span>
                      </button>
                    </div>
                    <div className="text-[var(--text-primary)] bg-[var(--bg-panel)] p-1.5 border border-[var(--border-grid)] select-all break-all text-[11px]">
                      {selectedChannelDetail.hintCommand}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ============================================================== */}
            {/* DRIVER-SPECIFIC HARDWARE FIELDS                                */}
            {/* ============================================================== */}
            {draft.driverFamily === 'slcan' && (
              <div
                style={{
                  backgroundColor: 'var(--bg-row-alt)',
                  borderColor: 'var(--border-strong)',
                }}
                className="p-2.5 border space-y-2.5"
              >
                <div className="font-semibold text-sky-500 flex items-center gap-1.5 text-[12px]">
                  <Usb className="w-4 h-4" />
                  <span>{t('conn.editor.slcanConfig')}</span>
                </div>

                {serialPorts.length > 0 && (
                  <div>
                    <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                      {t('conn.editor.detectedPorts')}
                    </label>
                    <select
                      aria-label={t('conn.editor.detectedPorts')}
                      value={
                        serialPorts.some((s) => s.portName === draft.serialPort)
                          ? draft.serialPort
                          : ''
                      }
                      onChange={(e) => {
                        if (e.target.value) {
                          setDraft((p) => {
                            const updated = { ...p, serialPort: e.target.value };
                            updated.deviceId = resolveDeviceIdForProfile(updated);
                            return updated;
                          });
                        }
                      }}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-[30px] px-2 border font-mono text-[12px]"
                    >
                      <option value="">{t('conn.editor.chooseDetectedPort')}</option>
                      {serialPorts.map((sp) => (
                        <option key={sp.portName} value={sp.portName}>
                          {sp.portName}
                          {sp.product ? ` — ${sp.product}` : ''}
                          {sp.vidPid ? ` (${sp.vidPid})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                      {t('conn.editor.serialPortLabel')}
                    </label>
                    <input
                      type="text"
                      value={draft.serialPort}
                      onChange={(e) =>
                        setDraft((p) => {
                          const updated = { ...p, serialPort: e.target.value };
                          updated.deviceId = resolveDeviceIdForProfile(updated);
                          return updated;
                        })
                      }
                      placeholder={defaultSerialPortPlaceholder(
                        connState.probeReport?.hostOs,
                      )}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor:
                          draft.serialPort.trim().length === 0
                            ? '#ef4444'
                            : 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-[30px] px-2.5 border font-mono text-[12px] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                      {t('conn.editor.uartBaudRate')}
                    </label>
                    <select
                      aria-label={t('conn.editor.uartBaudRate')}
                      value={draft.serialBaudRate}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          serialBaudRate: Number(e.target.value),
                        }))
                      }
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                    >
                      {SERIAL_BAUD_RATES.map((baud) => (
                        <option key={baud} value={baud}>
                          {baud.toLocaleString('en-US')} bps
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-[12px]">
                  <input
                    type="checkbox"
                    checked={draft.serialDtrRts}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, serialDtrRts: e.target.checked }))
                    }
                    className="accent-emerald-600 h-4 w-4"
                  />
                  <span>{t('conn.editor.assertDtrRts')}</span>
                </label>
              </div>
            )}

            {draft.driverFamily === 'pcan' && (
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.pcanChannel')}
                </label>
                <div className="flex gap-1.5">
                  <select
                    aria-label={t('conn.editor.pcanChannel')}
                    value={
                      pcanDetected.some((c) => c.channelId === draft.adapterChannel)
                        ? draft.adapterChannel
                        : ''
                    }
                    onChange={(e) => {
                      if (e.target.value) {
                        setDraft((p) => {
                          const updated = { ...p, adapterChannel: e.target.value };
                          updated.deviceId = resolveDeviceIdForProfile(updated);
                          return updated;
                        });
                      }
                    }}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="flex-1 h-[30px] px-2 border font-mono text-[12px]"
                  >
                    {pcanDetected.length === 0 ? (
                      <option value="" disabled>
                        {t('conn.pcan.noneDetected')}
                      </option>
                    ) : (
                      <option value="">{t('conn.pcan.quickSelect')}</option>
                    )}
                    {pcanDetected.map((c) => (
                      <option
                        key={c.channelId}
                        value={c.channelId}
                        style={c.occupied ? { color: 'var(--status-warn)' } : undefined}
                      >
                        {c.label}
                        {c.occupied ? ` · ${t('conn.pcan.inUse')}` : ''}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={draft.adapterChannel}
                    onChange={(e) =>
                      setDraft((p) => {
                        const updated = { ...p, adapterChannel: e.target.value };
                        updated.deviceId = resolveDeviceIdForProfile(updated);
                        return updated;
                      })
                    }
                    placeholder={PCAN_DEFAULT_CHANNEL}
                    list="pcan-manual-hint"
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-36 h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                  />
                  <datalist id="pcan-manual-hint">
                    {PCAN_MANUAL_ENTRY_HINT.map((ch) => (
                      <option key={ch} value={ch} />
                    ))}
                  </datalist>
                </div>
              </div>
            )}

            {draft.driverFamily === 'kvaser' && (
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.kvaserChannel')}
                </label>
                <div className="flex gap-1.5">
                  <select
                    aria-label={t('conn.editor.kvaserChannel')}
                    value={
                      KVASER_ADAPTER_CHANNELS.includes(draft.adapterChannel)
                        ? draft.adapterChannel
                        : ''
                    }
                    onChange={(e) => {
                      if (e.target.value) {
                        setDraft((p) => {
                          const updated = { ...p, adapterChannel: e.target.value };
                          updated.deviceId = resolveDeviceIdForProfile(updated);
                          return updated;
                        });
                      }
                    }}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="flex-1 h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                  >
                    <option value="">-- Quick Select Channel --</option>
                    {KVASER_ADAPTER_CHANNELS.map((ch) => (
                      <option key={ch} value={ch}>
                        Kvaser Channel {ch}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={draft.adapterChannel}
                    onChange={(e) =>
                      setDraft((p) => {
                        const updated = { ...p, adapterChannel: e.target.value };
                        updated.deviceId = resolveDeviceIdForProfile(updated);
                        return updated;
                      })
                    }
                    placeholder="0"
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-24 h-[30px] px-2 border font-mono text-center text-[12px]"
                  />
                </div>
              </div>
            )}

            {draft.driverFamily === 'vector_xl' && (
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.vectorXlChannel')}
                </label>
                <div className="flex gap-1.5">
                  <select
                    aria-label={t('conn.editor.vectorXlChannel')}
                    value={
                      VECTOR_XL_ADAPTER_CHANNELS.includes(
                        draft.adapterChannel as '0' | '1' | '2' | '3',
                      )
                        ? draft.adapterChannel
                        : ''
                    }
                    onChange={(e) => {
                      if (e.target.value) {
                        setDraft((p) => {
                          const updated = { ...p, adapterChannel: e.target.value };
                          updated.deviceId = resolveDeviceIdForProfile(updated);
                          return updated;
                        });
                      }
                    }}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="flex-1 h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                  >
                    <option value="">-- Quick Select Channel --</option>
                    {VECTOR_XL_ADAPTER_CHANNELS.map((ch) => (
                      <option key={ch} value={ch}>
                        Vector XL Channel {ch}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={draft.adapterChannel}
                    onChange={(e) =>
                      setDraft((p) => {
                        const updated = { ...p, adapterChannel: e.target.value };
                        updated.deviceId = resolveDeviceIdForProfile(updated);
                        return updated;
                      })
                    }
                    placeholder="0"
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-24 h-[30px] px-2 border font-mono text-center text-[12px]"
                  />
                </div>
              </div>
            )}

            {(draft.driverFamily === 'socketcan' ||
              draft.driverFamily === 'gs_usb') && (
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {draft.driverFamily === 'socketcan'
                    ? t('conn.editor.socketcanInterface')
                    : t('conn.editor.gsUsbDeviceIndex')}
                </label>
                <input
                  type="text"
                  value={draft.adapterChannel}
                  onChange={(e) =>
                    setDraft((p) => {
                      const updated = { ...p, adapterChannel: e.target.value };
                      updated.deviceId = resolveDeviceIdForProfile(updated);
                      return updated;
                    })
                  }
                  placeholder={
                    draft.driverFamily === 'socketcan' ? 'can0 or vcan0' : '0'
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2.5 border font-mono text-[12px] focus:outline-none"
                />
              </div>
            )}

            {draft.driverFamily === 'mock' && (
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                    {t('conn.editor.virtualChannel')}
                  </label>
                  <select
                    aria-label={t('conn.editor.virtualChannel')}
                    value={draft.adapterChannel || 'mock0'}
                    onChange={(e) =>
                      setDraft((p) => {
                        const updated = { ...p, adapterChannel: e.target.value };
                        updated.deviceId = resolveDeviceIdForProfile(updated);
                        return updated;
                      })
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-full h-[30px] px-2 border font-mono text-[12px]"
                  >
                    <option value="mock0">{t('conn.editor.mock0Primary')}</option>
                    <option value="mock1">{t('conn.editor.mock1Aux')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                    {t('conn.editor.trafficPacing')}
                  </label>
                  <select
                    aria-label={t('conn.editor.trafficPacing')}
                    value={
                      draft.mockFpsPreset === null
                        ? 'calm'
                        : String(draft.mockFpsPreset)
                    }
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        mockFpsPreset:
                          e.target.value === 'calm'
                            ? null
                            : Number(e.target.value),
                      }))
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                  >
                    <option value="calm">{t('conn.editor.pacingCalm')}</option>
                    <option value="475">{t('conn.editor.pacingNominal')}</option>
                    <option value="1000">{t('conn.editor.pacingBench1k')}</option>
                    <option value="10000">{t('conn.editor.pacingStress10k')}</option>
                    <option value="25000">{t('conn.editor.pacingStress25k')}</option>
                    <option value="50000">{t('conn.editor.pacingStress50k')}</option>
                  </select>
                </div>
              </div>
            )}

            {/* CAN / CAN-FD Bit Timing */}
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.nominalBitrate')}
                </label>
                <select
                  aria-label={t('conn.editor.nominalBitrate')}
                  value={draft.bitrate}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, bitrate: Number(e.target.value) }))
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                >
                  {NOMINAL_BITRATES.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.fdDataBitrate')}
                </label>
                <select
                  aria-label={t('conn.editor.fdDataBitrate')}
                  disabled={!draft.enableFd || draft.driverFamily === 'slcan'}
                  value={draft.dataBitrate}
                  onChange={(e) =>
                    setDraft((p) => ({
                      ...p,
                      dataBitrate: Number(e.target.value),
                    }))
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px] disabled:opacity-50"
                >
                  {DATA_BITRATES_FD.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {draft.driverFamily !== 'slcan' && (
              <label className="flex items-center gap-2 cursor-pointer text-[12px]">
                <input
                  type="checkbox"
                  checked={draft.enableFd}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, enableFd: e.target.checked }))
                  }
                  className="accent-sky-600 h-4 w-4"
                />
                <span>{t('conn.editor.enableCanFd')}</span>
              </label>
            )}

            {/* Safety & Project Auto-Connect */}
            <div
              style={{
                backgroundColor: 'var(--bg-row-alt)',
                borderColor: 'var(--border-grid)',
              }}
              className="p-2.5 border space-y-2 text-[12px]"
            >
              <label className="flex items-center gap-2 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={draft.listenOnly}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, listenOnly: e.target.checked }))
                  }
                  className="accent-emerald-600 h-4 w-4"
                />
                <span>{t('conn.editor.listenOnlySafe')}</span>
              </label>

              {draft.driverFamily !== 'mock' && (
                <label
                  className="flex items-center gap-2 cursor-pointer text-[var(--text-secondary)]"
                  title={t('sec.hwlo.requireTip')}
                >
                  <input
                    type="checkbox"
                    checked={draft.requireHardwareListenOnly === true}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, requireHardwareListenOnly: e.target.checked }))
                    }
                    className="accent-emerald-600 h-4 w-4"
                  />
                  <span>{t('sec.hwlo.require')}</span>
                </label>
              )}

              <label className="flex items-center gap-2 cursor-pointer text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={draft.autoConnectOnProjectLoad}
                  onChange={(e) =>
                    setDraft((p) => ({
                      ...p,
                      autoConnectOnProjectLoad: e.target.checked,
                    }))
                  }
                  className="accent-sky-600 h-4 w-4"
                />
                <span>{t('conn.editor.autoConnect')}</span>
              </label>
            </div>

            {/* Bound signal databases (0..N per connection, applied live) */}
            <div>
              <DatabaseBindingPicker
                selectedIds={draft.databaseIds}
                onChange={(nextIds) => {
                  setDraft((p) => ({ ...p, databaseIds: nextIds }));
                  if (connState.profiles.some((p) => p.id === draft.id)) {
                    connectionStore.setProfileDatabases(draft.id, nextIds);
                  }
                }}
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                {t('conn.editor.notes')}
              </label>
              <input
                type="text"
                value={draft.notes}
                onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
                placeholder={t('conn.editor.notesPlaceholder')}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[30px] px-2.5 border text-[12px] focus:outline-none"
              />
            </div>

            {/* ============================================================== */}
            {/* DEDICATED COLLAPSIBLE/INLINE OS SOURCE PATHS & SETUP GUIDE     */}
            {/* ============================================================== */}
            <div
              style={{
                backgroundColor: 'var(--bg-row-alt)',
                borderColor: 'var(--border-strong)',
              }}
              className="p-2.5 border space-y-2.5 text-[12px]"
            >
              <div className="flex items-center justify-between gap-1 flex-wrap">
                <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5 text-sky-400" />
                  <span>{t('conn.guide.title')}</span>
                </span>

                {/* OS Preview Switcher Pills */}
                <div className="flex items-center gap-1 text-[10.5px] font-mono">
                  {(['active', 'linux', 'windows', 'macos'] as const).map(
                    (osKey) => (
                      <button
                        key={osKey}
                        type="button"
                        onClick={() => setGuideOsPreview(osKey)}
                        style={{
                          backgroundColor:
                            guideOsPreview === osKey
                              ? 'var(--bg-header)'
                              : 'var(--bg-panel)',
                          borderColor:
                            guideOsPreview === osKey
                              ? '#38bdf8'
                              : 'var(--border-grid)',
                          color:
                            guideOsPreview === osKey
                              ? '#38bdf8'
                              : 'var(--text-secondary)',
                        }}
                        className="px-1.5 py-0.5 border cursor-pointer uppercase font-medium"
                      >
                        {osKey === 'active'
                          ? t('conn.guide.activeHost')
                          : osKey}
                      </button>
                    ),
                  )}
                </div>
              </div>

              {/* 1) Data Source Paths */}
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center justify-between">
                  <span>
                    {t('conn.guide.sourcePaths')} ({effectiveGuideOs.toUpperCase()}):
                  </span>
                </div>
                <div className="bg-[var(--bg-panel)] p-2 border border-[var(--border-grid)] font-mono text-[11px] space-y-1 text-[var(--text-muted)] max-h-[90px] overflow-y-auto select-all">
                  {effectiveSourceLocations.length > 0 ? (
                    effectiveSourceLocations.map((loc, idx) => (
                      <div
                        key={idx}
                        className="truncate text-[var(--text-secondary)]"
                      >
                        • {loc}
                      </div>
                    ))
                  ) : (
                    <div className="text-[var(--text-muted)] italic">
                      No paths registered for this configuration.
                    </div>
                  )}
                </div>
              </div>

              {/* 2) Setup Steps & Troubleshooting */}
              {effectiveSetupSteps.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                    {t('conn.guide.setupSteps')}:
                  </div>
                  {effectiveSetupSteps.map((step, idx) => (
                    <div
                      key={idx}
                      className="p-2 border border-[var(--border-grid)] bg-[var(--bg-panel)] text-[11px] space-y-1"
                    >
                      <div className="flex items-center justify-between font-semibold text-[var(--text-primary)]">
                        <span>{step.title}</span>
                        {step.docUrl && (
                          <a
                            href={step.docUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-400 hover:underline flex items-center gap-0.5 text-[10px]"
                          >
                            <ExternalLink className="w-2.5 h-2.5" />
                            {t('conn.guide.openDoc')}
                          </a>
                        )}
                      </div>
                      <p className="text-[var(--text-secondary)] text-[11px] leading-relaxed">
                        {step.description}
                      </p>
                      {step.commandOrAction && (
                        <div className="flex items-center justify-between gap-1 bg-[var(--bg-toolbar)] p-1 border border-[var(--border-grid)] font-mono text-[10.5px]">
                          <span className="truncate select-all text-[var(--text-primary)]">
                            {step.commandOrAction}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyToClipboard(
                                step.commandOrAction!,
                                `step-${idx}`,
                              )
                            }
                            className="shrink-0 px-1.5 py-0.5 border border-[var(--border-strong)] hover:border-sky-400 text-sky-400 bg-[var(--bg-panel)] text-[10px] flex items-center gap-0.5 cursor-pointer"
                          >
                            {copiedKey === `step-${idx}` ? (
                              <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-2.5 h-2.5" />
                            )}
                            <span>
                              {copiedKey === `step-${idx}`
                                ? t('conn.guide.copied')
                                : t('conn.guide.copyCmd')}
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Editor Action Footer */}
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderTop: '1px solid var(--border-strong)',
            }}
            className="shrink-0 p-2.5 flex items-center justify-end gap-2.5"
          >
            <button
              type="button"
              onClick={() => {
                handleSaveDraft();
              }}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[30px] px-3.5 border flex items-center gap-1.5 text-[12px] font-medium hover:border-[var(--text-secondary)] cursor-pointer"
            >
              <Save className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('conn.editor.saveProfile')}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleSaveAndConnect()}
              style={{
                backgroundColor: 'rgba(63, 185, 128, 0.16)',
                borderColor: 'rgba(63, 185, 128, 0.65)',
                color: 'var(--text-primary)',
              }}
              className="h-[30px] px-3.5 border flex items-center gap-1.5 text-[12px] font-semibold hover:opacity-90 cursor-pointer"
            >
              <Plug className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t('conn.editor.saveAndConnect')}</span>
            </button>
          </div>
        </aside>
      )}
      </div>
    </div>
  );
};
