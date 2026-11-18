/**
 * Industrial CAN Error Frame Decoder (Linux <linux/can/error.h> & gs_usb / SocketCAN standard).
 * Decodes arbId error class mask and data payload bytes down to bit-level diagnostics.
 */

export interface DecodedErrorField {
  label: string;
  value: string;
  isCritical?: boolean;
}

export const CAN_ERR_MASK = 0x1fff_ffff;

// Error class masks in can_id
export const CAN_ERR_TX_TIMEOUT = 0x00000001; // TX timeout (by driver)
export const CAN_ERR_LOSTARB    = 0x00000002; // Lost arbitration / data[0]
export const CAN_ERR_CRTL       = 0x00000004; // Controller problems / data[1]
export const CAN_ERR_PROT       = 0x00000008; // Protocol violations / data[2..3]
export const CAN_ERR_TRX        = 0x00000010; // Transceiver status / data[4]
export const CAN_ERR_ACK        = 0x00000020; // Received no ACK on transmission
export const CAN_ERR_BUSOFF     = 0x00000040; // Bus off
export const CAN_ERR_BUSERROR   = 0x00000080; // Bus error
export const CAN_ERR_RESTARTED  = 0x00000100; // Controller restarted
export const CAN_ERR_CNT        = 0x00000200; // Error counters in data[6..7]

// Data[1] Controller Problems
export const CAN_ERR_CRTL_RX_OVERFLOW = 0x01;
export const CAN_ERR_CRTL_TX_OVERFLOW = 0x02;
export const CAN_ERR_CRTL_RX_WARNING  = 0x04;
export const CAN_ERR_CRTL_TX_WARNING  = 0x08;
export const CAN_ERR_CRTL_RX_PASSIVE  = 0x10;
export const CAN_ERR_CRTL_TX_PASSIVE  = 0x20;
export const CAN_ERR_CRTL_ACTIVE      = 0x40;

// Data[2] Protocol Violation Types
export const CAN_ERR_PROT_BIT      = 0x01; // Single bit error
export const CAN_ERR_PROT_FORM     = 0x02; // Frame format (form) error
export const CAN_ERR_PROT_STUFF    = 0x04; // Bit stuffing error
export const CAN_ERR_PROT_BIT0     = 0x08; // Unable to send dominant bit
export const CAN_ERR_PROT_BIT1     = 0x10; // Unable to send recessive bit
export const CAN_ERR_PROT_OVERLOAD = 0x20; // Bus overload
export const CAN_ERR_PROT_ACTIVE   = 0x40; // Active error announcement
export const CAN_ERR_PROT_TX       = 0x80; // Error occurred on transmission

// Data[3] Protocol Violation Locations
export const PROT_LOC_MAP: Record<number, string> = {
  0x03: 'SOF',
  0x02: 'ID bits 28-21 (SFF: 10-3)',
  0x06: 'ID bits 20-18 (SFF: 2-0)',
  0x04: 'SRTR (SFF: RTR)',
  0x05: 'IDE',
  0x07: 'ID bits 17-13',
  0x0f: 'ID bits 12-5',
  0x0e: 'ID bits 4-0',
  0x0c: 'RTR',
  0x0d: 'Reserved Bit 1',
  0x09: 'Reserved Bit 0',
  0x0b: 'DLC',
  0x0a: 'Data Field',
  0x08: 'CRC Sequence',
  0x18: 'CRC Delimiter',
  0x19: 'ACK Slot',
  0x1b: 'ACK Delimiter',
  0x1a: 'EOF',
  0x12: 'Intermission',
};

// Data[4] Transceiver Status
export const TRX_MAP: Record<number, string> = {
  0x04: 'CAN-H: No Wire',
  0x05: 'CAN-H: Short to BAT',
  0x06: 'CAN-H: Short to VCC',
  0x07: 'CAN-H: Short to GND',
  0x40: 'CAN-L: No Wire',
  0x50: 'CAN-L: Short to BAT',
  0x60: 'CAN-L: Short to VCC',
  0x70: 'CAN-L: Short to GND',
  0x80: 'CAN-L: Short to CAN-H',
};

/**
 * Formats a concise single-line error title suitable for table rows and summaries.
 * E.g. "ERR [00Ch] CRTL+PROT: TX-Passive · Bit0-Dom (TX) @ACK-Slot [TEC=128 REC=0]"
 */
export function formatErrorFrameShortTitle(
  arbId: number,
  rawBytes: readonly number[],
  backendSummary?: string | null,
): string {
  const errMask = arbId & CAN_ERR_MASK;
  const hexMask = errMask.toString(16).toUpperCase().padStart(3, '0');

  const classes: string[] = [];
  const details: string[] = [];

  if (errMask & CAN_ERR_BUSOFF) {
    classes.push('BUS-OFF');
    details.push('Bus-Off State Entered');
  }
  if (errMask & CAN_ERR_TX_TIMEOUT) {
    classes.push('TX-TIMEOUT');
    details.push('Transmit Timeout');
  }
  if (errMask & CAN_ERR_LOSTARB) {
    classes.push('LOSTARB');
    const bit = rawBytes[0] ?? 0;
    details.push(bit > 0 ? `Lost Arb at Bit ${bit}` : 'Lost Arbitration');
  }
  if (errMask & CAN_ERR_CRTL) {
    classes.push('CRTL');
    const crtl = rawBytes[1] ?? 0;
    const crtlParts: string[] = [];
    if (crtl & CAN_ERR_CRTL_RX_OVERFLOW) crtlParts.push('RX-Ovf');
    if (crtl & CAN_ERR_CRTL_TX_OVERFLOW) crtlParts.push('TX-Ovf');
    if (crtl & CAN_ERR_CRTL_RX_WARNING) crtlParts.push('RX-Warn');
    if (crtl & CAN_ERR_CRTL_TX_WARNING) crtlParts.push('TX-Warn');
    if (crtl & CAN_ERR_CRTL_RX_PASSIVE) crtlParts.push('RX-Passive');
    if (crtl & CAN_ERR_CRTL_TX_PASSIVE) crtlParts.push('TX-Passive');
    if (crtl & CAN_ERR_CRTL_ACTIVE) crtlParts.push('Active');
    if (crtlParts.length > 0) {
      details.push(crtlParts.join('+'));
    }
  }
  if (errMask & CAN_ERR_PROT) {
    classes.push('PROT');
    const protType = rawBytes[2] ?? 0;
    const protLoc = rawBytes[3] ?? 0;
    const typeParts: string[] = [];
    if (protType & CAN_ERR_PROT_BIT) typeParts.push('Bit-Err');
    if (protType & CAN_ERR_PROT_FORM) typeParts.push('Form-Err');
    if (protType & CAN_ERR_PROT_STUFF) typeParts.push('Stuff-Err');
    if (protType & CAN_ERR_PROT_BIT0) typeParts.push('Bit0-Dom');
    if (protType & CAN_ERR_PROT_BIT1) typeParts.push('Bit1-Rec');
    if (protType & CAN_ERR_PROT_OVERLOAD) typeParts.push('Overload');
    if (protType & CAN_ERR_PROT_ACTIVE) typeParts.push('Active-Announce');
    const dir = protType & CAN_ERR_PROT_TX ? ' (TX)' : ' (RX)';
    const locStr = PROT_LOC_MAP[protLoc] ? ` @${PROT_LOC_MAP[protLoc]}` : '';
    const protSummary = `${typeParts.join('+') || 'Protocol-Violation'}${dir}${locStr}`;
    details.push(protSummary);
  }
  if (errMask & CAN_ERR_TRX) {
    classes.push('TRX');
    const trx = rawBytes[4] ?? 0;
    details.push(TRX_MAP[trx] || `Trx-Fault(0x${trx.toString(16).padStart(2, '0')})`);
  }
  if (errMask & CAN_ERR_ACK) {
    classes.push('NO-ACK');
    details.push('No ACK Received on TX');
  }
  if (errMask & CAN_ERR_BUSERROR) {
    classes.push('BUS-ERR');
  }
  if (errMask & CAN_ERR_RESTARTED) {
    classes.push('RESTARTED');
    details.push('Controller Restarted');
  }

  // Error counters in data[6..7]
  const tec = rawBytes.length >= 7 ? rawBytes[6] : undefined;
  const rec = rawBytes.length >= 8 ? rawBytes[7] : undefined;
  let counterSuffix = '';
  if ((tec !== undefined && tec > 0) || (rec !== undefined && rec > 0) || (errMask & CAN_ERR_CNT)) {
    counterSuffix = ` [TEC=${tec ?? 0} REC=${rec ?? 0}]`;
  }

  const classStr = classes.join('+') || (backendSummary ? backendSummary : 'UNKNOWN-ERR');
  const detailStr = details.length > 0 ? `: ${details.join(' · ')}` : backendSummary ? `: ${backendSummary}` : '';

  return `ERR [${hexMask}h] ${classStr}${detailStr}${counterSuffix}`;
}

/**
 * Returns detailed breakdown fields for an Error Frame for expandable inspection sub-rows.
 */
export function decodeCanErrorFields(
  arbId: number,
  rawBytes: readonly number[],
): DecodedErrorField[] {
  const fields: DecodedErrorField[] = [];
  const errMask = arbId & CAN_ERR_MASK;
  const hexMask = `0x${errMask.toString(16).toUpperCase().padStart(4, '0')}`;

  fields.push({
    label: 'Error Mask',
    value: `${hexMask} (${errMask})`,
    isCritical: Boolean(errMask & (CAN_ERR_BUSOFF | CAN_ERR_TX_TIMEOUT)),
  });

  if (errMask & CAN_ERR_BUSOFF) {
    fields.push({
      label: 'Bus State',
      value: 'BUS-OFF (Node disconnected from CAN bus)',
      isCritical: true,
    });
  }

  if (errMask & CAN_ERR_TX_TIMEOUT) {
    fields.push({
      label: 'TX Timeout',
      value: 'Driver transmit queue timeout',
      isCritical: true,
    });
  }

  if (errMask & CAN_ERR_LOSTARB) {
    const bit = rawBytes[0] ?? 0;
    fields.push({
      label: 'Lost Arbitration',
      value: bit > 0 ? `Lost at bit position ${bit}` : 'Unspecified bit position',
    });
  }

  if (errMask & CAN_ERR_CRTL) {
    const crtl = rawBytes[1] ?? 0;
    const items: string[] = [];
    let isCrit = false;
    if (crtl & CAN_ERR_CRTL_RX_OVERFLOW) {
      items.push('RX Buffer Overflow');
      isCrit = true;
    }
    if (crtl & CAN_ERR_CRTL_TX_OVERFLOW) {
      items.push('TX Buffer Overflow');
      isCrit = true;
    }
    if (crtl & CAN_ERR_CRTL_RX_WARNING) items.push('RX Warning Limit Reached (REC >= 96)');
    if (crtl & CAN_ERR_CRTL_TX_WARNING) items.push('TX Warning Limit Reached (TEC >= 96)');
    if (crtl & CAN_ERR_CRTL_RX_PASSIVE) {
      items.push('RX Error Passive State (REC >= 128)');
      isCrit = true;
    }
    if (crtl & CAN_ERR_CRTL_TX_PASSIVE) {
      items.push('TX Error Passive State (TEC >= 128)');
      isCrit = true;
    }
    if (crtl & CAN_ERR_CRTL_ACTIVE) items.push('Recovered to Error Active State');

    fields.push({
      label: 'Controller Status (data[1])',
      value: items.join(', ') || `0x${crtl.toString(16).padStart(2, '0')}`,
      isCritical: isCrit,
    });
  }

  if (errMask & CAN_ERR_PROT) {
    const protType = rawBytes[2] ?? 0;
    const protLoc = rawBytes[3] ?? 0;

    const typeItems: string[] = [];
    if (protType & CAN_ERR_PROT_BIT) typeItems.push('Single Bit Error');
    if (protType & CAN_ERR_PROT_FORM) typeItems.push('Frame Format (Form) Error');
    if (protType & CAN_ERR_PROT_STUFF) typeItems.push('Bit Stuffing Error');
    if (protType & CAN_ERR_PROT_BIT0) typeItems.push('Dominant Bit 0 Error');
    if (protType & CAN_ERR_PROT_BIT1) typeItems.push('Recessive Bit 1 Error');
    if (protType & CAN_ERR_PROT_OVERLOAD) typeItems.push('Bus Overload');
    if (protType & CAN_ERR_PROT_ACTIVE) typeItems.push('Active Error Announcement');

    const direction = protType & CAN_ERR_PROT_TX ? 'Transmit (TX)' : 'Receive (RX)';
    const locName = PROT_LOC_MAP[protLoc] || `Code 0x${protLoc.toString(16).padStart(2, '0')}`;

    fields.push({
      label: 'Protocol Violation Type (data[2])',
      value: `${typeItems.join(', ') || 'Unspecified'} [Direction: ${direction}]`,
      isCritical: Boolean(protType & (CAN_ERR_PROT_BIT0 | CAN_ERR_PROT_BIT1)),
    });

    fields.push({
      label: 'Protocol Error Location (data[3])',
      value: `${locName} (raw: 0x${protLoc.toString(16).padStart(2, '0')})`,
      isCritical: protLoc === 0x19, // ACK slot is common critical indicator
    });
  }

  if (errMask & CAN_ERR_TRX) {
    const trx = rawBytes[4] ?? 0;
    const desc = TRX_MAP[trx] || `Fault Code 0x${trx.toString(16).padStart(2, '0')}`;
    fields.push({
      label: 'Transceiver Status (data[4])',
      value: desc,
      isCritical: true,
    });
  }

  if (errMask & CAN_ERR_ACK) {
    fields.push({
      label: 'ACK Delimiter / Slot',
      value: 'No ACK received on transmission (check cable termination or bus listen-only state)',
      isCritical: true,
    });
  }

  if (errMask & CAN_ERR_RESTARTED) {
    fields.push({
      label: 'Controller Restart',
      value: 'CAN controller was restarted after recovery',
    });
  }

  // Error Counters (TEC / REC) in data[6..7]
  if (rawBytes.length >= 8) {
    const tec = rawBytes[6];
    const rec = rawBytes[7];
    fields.push({
      label: 'Error Counters (TEC / REC)',
      value: `Transmit Error Counter (TEC) = ${tec} | Receive Error Counter (REC) = ${rec}`,
      isCritical: tec >= 128 || rec >= 128,
    });
  }

  return fields;
}
