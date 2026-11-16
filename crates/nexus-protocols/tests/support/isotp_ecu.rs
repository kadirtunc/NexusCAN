//! Test-only scripted ISO-TP ECU (ISO 15765-2 receiver + sender) with an optional address
//! byte (extended / mixed addressing), classic CAN or CAN-FD. Pure: frame payload in → frame
//! payloads out. Used by the in-memory port tests and the vcan0 HIL tests.
#![allow(dead_code)]

use std::collections::VecDeque;

/// Valid CAN-FD data lengths.
const FD_LENS: [usize; 8] = [8, 12, 16, 20, 24, 32, 48, 64];

/// UDS handler: request PDU → response PDUs (sent in order).
pub type Handler = Box<dyn FnMut(&[u8]) -> Vec<Vec<u8>> + Send>;

pub struct IsoTpEcu {
    /// Prefix of every frame the ECU sends (response address byte).
    pub tx_addr: Option<u8>,
    /// Required first byte of tester frames (target address byte).
    pub rx_addr: Option<u8>,
    pub fd: bool,
    pub pad: u8,
    handler: Handler,
    /// Reassembly: (announced length, bytes so far, next SN).
    rx: Option<(usize, Vec<u8>, u8)>,
    /// CFs waiting for the tester's FC.CTS.
    pending_cfs: VecDeque<Vec<u8>>,
    /// Tester frames ignored because of a foreign address byte.
    pub foreign: usize,
}

impl IsoTpEcu {
    pub fn new(tx_addr: Option<u8>, rx_addr: Option<u8>, fd: bool, handler: Handler) -> Self {
        Self {
            tx_addr,
            rx_addr,
            fd,
            pad: 0xCC,
            handler,
            rx: None,
            pending_cfs: VecDeque::new(),
            foreign: 0,
        }
    }

    fn off(&self) -> usize {
        usize::from(self.tx_addr.is_some())
    }

    /// Prefix + pad to 8 bytes (classic) / the smallest valid FD length >= 8.
    pub fn frame(&self, body: &[u8]) -> Vec<u8> {
        let mut f = Vec::with_capacity(64);
        f.extend(self.tx_addr);
        f.extend_from_slice(body);
        let target = if self.fd {
            FD_LENS.into_iter().find(|&l| l >= f.len()).unwrap_or(64)
        } else {
            8
        };
        f.resize(target, self.pad);
        f
    }

    /// Segments one response PDU: SF, or FF (the CFs wait for FC.CTS).
    pub fn segment(&mut self, pdu: &[u8]) -> Vec<Vec<u8>> {
        let off = self.off();
        let dl = if self.fd { 64 } else { 8 } - off;
        if pdu.len() < 8 - off {
            let mut b = vec![pdu.len() as u8];
            b.extend_from_slice(pdu);
            return vec![self.frame(&b)];
        }
        if self.fd && pdu.len() <= dl - 2 {
            let mut b = vec![0x00, pdu.len() as u8];
            b.extend_from_slice(pdu);
            return vec![self.frame(&b)];
        }
        let mut b = if pdu.len() <= 4095 {
            vec![0x10 | (pdu.len() >> 8) as u8, pdu.len() as u8]
        } else {
            let mut v = vec![0x10, 0x00];
            v.extend((pdu.len() as u32).to_be_bytes());
            v
        };
        let first = dl - b.len();
        b.extend_from_slice(&pdu[..first]);
        for (i, chunk) in pdu[first..].chunks(dl - 1).enumerate() {
            let mut c = vec![0x20 | ((i + 1) & 0x0F) as u8];
            c.extend_from_slice(chunk);
            let f = self.frame(&c);
            self.pending_cfs.push_back(f);
        }
        vec![self.frame(&b)]
    }

    fn respond(&mut self, req: &[u8]) -> Vec<Vec<u8>> {
        let pdus = (self.handler)(req);
        pdus.iter().flat_map(|p| self.segment(p)).collect()
    }

    /// One tester frame → ECU frames to send.
    pub fn on_frame(&mut self, payload: &[u8]) -> Vec<Vec<u8>> {
        let data = match self.rx_addr {
            None => payload,
            Some(a) => match payload.split_first() {
                Some((&b, rest)) if b == a => rest,
                _ => {
                    self.foreign += 1;
                    return Vec::new();
                }
            },
        };
        let Some(&b0) = data.first() else {
            return Vec::new();
        };
        match b0 >> 4 {
            0 => {
                let (len, hdr) = if b0 & 0x0F != 0 {
                    (usize::from(b0 & 0x0F), 1)
                } else {
                    (usize::from(*data.get(1).unwrap_or(&0)), 2)
                };
                let Some(req) = data.get(hdr..hdr + len) else {
                    return Vec::new();
                };
                let req = req.to_vec();
                self.respond(&req)
            }
            1 => {
                let short = (usize::from(b0 & 0x0F) << 8) | usize::from(data[1]);
                let (total, hdr) = if short == 0 {
                    (
                        u32::from_be_bytes([data[2], data[3], data[4], data[5]]) as usize,
                        6,
                    )
                } else {
                    (short, 2)
                };
                self.rx = Some((total, data[hdr..].to_vec(), 1));
                vec![self.frame(&[0x30, 0x00, 0x00])]
            }
            2 => {
                let Some((total, mut buf, sn)) = self.rx.take() else {
                    return Vec::new();
                };
                if b0 & 0x0F != sn {
                    return Vec::new();
                }
                let need = total - buf.len();
                buf.extend_from_slice(&data[1..(1 + need).min(data.len())]);
                if buf.len() >= total {
                    buf.truncate(total);
                    return self.respond(&buf);
                }
                self.rx = Some((total, buf, (sn + 1) & 0x0F));
                Vec::new()
            }
            3 if b0 & 0x0F == 0 => self.pending_cfs.drain(..).collect(),
            _ => Vec::new(),
        }
    }
}
