import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

export type HeroConceptId = '01' | '02' | '03' | '04';

interface ConceptMeta {
  id: HeroConceptId;
  label: string;
  shortName: string;
  description: string;
}

const CONCEPTS: readonly ConceptMeta[] = [
  {
    id: '01',
    label: '01 · Signal Lock',
    shortName: 'Signal Lock',
    description: 'Oscilloscope Reticle & Differential CAN Beam Synchronization',
  },
  {
    id: '02',
    label: '02 · Silicon ECU',
    shortName: 'Silicon ECU',
    description: 'QFN-32 Transceiver Chip & 45° Angle PCB Differential Bus',
  },
  {
    id: '03',
    label: '03 · Eye Diagram',
    shortName: 'Eye Diagram',
    description: '60 FPS Physical Layer CAN-FD Eye Pattern & Bit-Timing Analysis',
  },
  {
    id: '04',
    label: '04 · Tactical Boot',
    shortName: 'Tactical Boot',
    description: 'Aerospace Instrument Laser Calibration & Subsystem Verification',
  },
];

const LOCAL_STORAGE_KEY = 'nexuscan_hero_concept';

// ============================================================================
// 1. HIGH-PRECISION ANIMATED VECTOR LOGO (FAITHFUL TO public/logo.png)
// ============================================================================
interface NexusCanVectorLogoProps {
  size?: number;
  className?: string;
  glow?: boolean;
  replayNonce?: number;
  chipPins?: boolean;
  animated?: boolean;
}

export const NexusCanVectorLogo: React.FC<NexusCanVectorLogoProps> = ({
  size = 88,
  className = '',
  glow = true,
  replayNonce = 0,
  chipPins = false,
  animated = true,
}) => {
  return (
    <div
      style={{ width: `${size}px`, height: `${size}px` }}
      className={`relative select-none shrink-0 flex items-center justify-center ${className}`}
    >
      {/* Expanding Cyan Signal Lock Ring upon Lock (~500ms) */}
      {animated && (
        <div
          key={`ring-${replayNonce}`}
          className="absolute inset-0 rounded-lg border-2 border-cyan-400 pointer-events-none animate-[nexusLockRingExpand_0.65s_var(--ease-out)_0.48s_forwards]"
          style={{ opacity: 0 }}
        />
      )}

      <svg
        key={`logo-svg-${replayNonce}`}
        viewBox="0 0 32 32"
        width={size}
        height={size}
        className="overflow-visible"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Gradient for continuous square wave: Electric Cyan -> Emerald Green */}
          <linearGradient id="nexusWaveGrad" x1="4" y1="10" x2="28" y2="17" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#00D8FF" />
            <stop offset="50%" stopColor="#06B6D4" />
            <stop offset="100%" stopColor="#10E88A" />
          </linearGradient>

          {/* Carrier light pulse gradient */}
          <linearGradient id="nexusCarrierGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="50%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>

          {/* Subtle radial inner glow */}
          <radialGradient id="nexusInnerGlow" cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="rgba(6, 182, 212, 0.16)" />
            <stop offset="100%" stopColor="rgba(11, 15, 23, 0)" />
          </radialGradient>

          {/* Glow filter for active pulses */}
          <filter id="nexusGlowFilter" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.1" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* QFN Micro-lead Pins (Used in Concept 02: Silicon ECU) */}
        {chipPins && (
          <g stroke="#144B5B" strokeWidth="1.2" strokeLinecap="square">
            {/* Left 4 pins */}
            <line x1="-2.5" y1="8" x2="1" y2="8" stroke="#00D8FF" strokeOpacity="0.8" />
            <line x1="-2.5" y1="13" x2="1" y2="13" stroke="#00D8FF" strokeOpacity="0.8" />
            <line x1="-2.5" y1="19" x2="1" y2="19" stroke="#10E88A" strokeOpacity="0.8" />
            <line x1="-2.5" y1="24" x2="1" y2="24" stroke="#10E88A" strokeOpacity="0.8" />

            {/* Right 4 pins */}
            <line x1="31" y1="8" x2="34.5" y2="8" stroke="#00D8FF" strokeOpacity="0.8" />
            <line x1="31" y1="13" x2="34.5" y2="13" stroke="#00D8FF" strokeOpacity="0.8" />
            <line x1="31" y1="19" x2="34.5" y2="19" stroke="#10E88A" strokeOpacity="0.8" />
            <line x1="31" y1="24" x2="34.5" y2="24" stroke="#10E88A" strokeOpacity="0.8" />

            {/* Top 4 pins */}
            <line x1="8" y1="-2.5" x2="8" y2="1" stroke="#0E7490" strokeOpacity="0.7" />
            <line x1="13" y1="-2.5" x2="13" y2="1" stroke="#0E7490" strokeOpacity="0.7" />
            <line x1="19" y1="-2.5" x2="19" y2="1" stroke="#0E7490" strokeOpacity="0.7" />
            <line x1="24" y1="-2.5" x2="24" y2="1" stroke="#0E7490" strokeOpacity="0.7" />

            {/* Bottom 4 pins */}
            <line x1="8" y1="31" x2="8" y2="34.5" stroke="#0E7490" strokeOpacity="0.7" />
            <line x1="13" y1="31" x2="13" y2="34.5" stroke="#0E7490" strokeOpacity="0.7" />
            <line x1="19" y1="31" x2="19" y2="34.5" stroke="#0E7490" strokeOpacity="0.7" />
            <line x1="24" y1="31" x2="24" y2="34.5" stroke="#0E7490" strokeOpacity="0.7" />
          </g>
        )}

        {/* 1. Silicon Obsidian Body (Matches #0B0F17) with Cyan/Teal border (#0E7490) */}
        {/* Stage 1: Border stroke drawn with ease-out, body smoothly enters */}
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="3"
          fill="#0B0F17"
          stroke="#0E7490"
          strokeWidth="1.8"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={animated ? 100 : 0}
          className={animated ? 'animate-[nexusDrawPath_0.32s_var(--ease-out)_forwards]' : undefined}
        />

        {/* Inner subtle glow fill */}
        <rect x="2" y="2" width="28" height="28" rx="2" fill="url(#nexusInnerGlow)" />

        {/* Pin 1 orientation chamfer mark in top-left */}
        {chipPins && (
          <circle cx="4.5" cy="4.5" r="1.1" fill="#00D8FF" fillOpacity="0.75" />
        )}

        {/* 2. Double-Stepped Square Wave Path (Pulse 1 mid, Valley, Pulse 2 CAN-FD BRS high) */}
        {/* Stage 2: Wave drawn left-to-right (0.14s–0.62s) */}
        <path
          d="M 3 15.5 H 6 V 10.5 H 14 V 15.5 H 18 V 9.5 H 25 V 15.5 H 29"
          stroke="url(#nexusWaveGrad)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={animated ? 100 : 0}
          className={animated ? 'animate-[nexusDrawPath_0.48s_var(--ease-out)_0.14s_forwards]' : undefined}
          filter={glow ? 'url(#nexusGlowFilter)' : undefined}
        />

        {/* Glowing carrier signal pulse continuously traveling along the wave */}
        {animated && (
          <path
            d="M 3 15.5 H 6 V 10.5 H 14 V 15.5 H 18 V 9.5 H 25 V 15.5 H 29"
            stroke="#FFFFFF"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={100}
            strokeDasharray="18 82"
            className="animate-[nexusCarrierPulse_1.8s_linear_infinite]"
            filter="url(#nexusGlowFilter)"
          />
        )}

        {/* 3. Lower Horizontal Emerald Reference Bar 1 (Under Pulse 1) */}
        {/* Stage 3: Opens left-to-right with clip-path (0.36s) */}
        <rect
          x="6"
          y="21"
          width="8"
          height="1.8"
          rx="0.5"
          fill="#10B981"
          style={{ clipPath: animated ? 'inset(0 100% 0 0)' : undefined }}
          className={animated ? 'animate-[nexusBarReveal_0.32s_var(--ease-out)_0.36s_forwards]' : undefined}
          filter={glow ? 'url(#nexusGlowFilter)' : undefined}
        />

        {/* 4. Lower Horizontal Emerald Reference Bar 2 (Under Pulse 2, stepped 1px lower!) */}
        {/* Stage 3 (Staggered 90ms): Opens left-to-right with clip-path (0.45s) */}
        <rect
          x="18"
          y="22.2"
          width="7"
          height="1.8"
          rx="0.5"
          fill="#10B981"
          style={{ clipPath: animated ? 'inset(0 100% 0 0)' : undefined }}
          className={animated ? 'animate-[nexusBarReveal_0.32s_var(--ease-out)_0.45s_forwards]' : undefined}
          filter={glow ? 'url(#nexusGlowFilter)' : undefined}
        />
      </svg>
    </div>
  );
};

// ============================================================================
// 2. CONCEPT 01: SIGNAL LOCK (CANLI OSİLOSKOP & DİFERANSİYEL SİNYAL KİLİDİ)
// ============================================================================
interface ConceptSignalLockProps {
  replayNonce: number;
}

const DECODED_BADGES = [
  { label: '0x101', cls: 'bg-cyan-950/60 text-cyan-300 border-cyan-500/40 font-bold' },
  { label: 'SOF', cls: 'bg-[#171A1E] text-slate-300 border-slate-700' },
  { label: 'FDF', cls: 'bg-cyan-950/60 text-cyan-400 border-cyan-500/30 font-bold' },
  { label: 'BRS ↑ 2M', cls: 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40 font-bold' },
  { label: 'DLC:64', cls: 'bg-[#171A1E] text-slate-300 border-slate-700' },
  { label: 'CRC:21', cls: 'bg-amber-950/60 text-amber-300 border-amber-500/40' },
  { label: 'ACK', cls: 'bg-emerald-950/60 text-emerald-400 border-emerald-500/40 font-bold' },
];

const ConceptSignalLock: React.FC<ConceptSignalLockProps> = ({ replayNonce }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [triggerX, setTriggerX] = useState<number>(310);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(40, Math.min(rect.width - 40, e.clientX - rect.left));
    setTriggerX(x);
  }, []);

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      className="relative w-full h-[220px] rounded-lg overflow-hidden border border-[#0E7490]/40 bg-[#080D14] flex flex-col justify-between p-4 cursor-crosshair select-none"
    >
      {/* Oscilloscope Reticle Grid (20px cells with center tick lines) */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20">
        <defs>
          <pattern id="reticleGrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#0E7490" strokeWidth="0.8" />
            <circle cx="12" cy="12" r="0.8" fill="#00D8FF" opacity="0.6" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#reticleGrid)" />
        {/* Center horizontal and vertical major axes */}
        <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#00D8FF" strokeWidth="0.9" strokeDasharray="2 4" opacity="0.6" />
        <line x1="50%" y1="0" x2="50%" y2="100%" stroke="#00D8FF" strokeWidth="0.9" strokeDasharray="2 4" opacity="0.6" />
      </svg>

      {/* Dynamic Reticle Trigger Marker Cursor (Follows cursor smoothly) */}
      <div
        style={{
          transform: `translateX(${triggerX}px)`,
          transition: 'transform 60ms linear',
        }}
        className="absolute top-0 bottom-0 w-[1px] bg-cyan-400/35 pointer-events-none z-10 flex flex-col items-center justify-between"
      >
        <span className="text-[9px] font-mono font-bold text-cyan-300 bg-[#080D14]/90 px-1 border border-cyan-500/50 rounded-sm -mt-1">
          T:{(triggerX * 1.6).toFixed(0)}ns
        </span>
        <span className="text-[8px] font-mono text-cyan-400/80 mb-1">TRIG</span>
      </div>

      {/* Top Oscilloscope Instrumentation Status Bar */}
      <div className="relative z-20 flex items-center justify-between text-[10px] font-mono tabular-nums border-b border-[#0E7490]/30 pb-1.5">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-emerald-400 font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
            TRIG: LOCKED
          </span>
          <span className="text-[#9099A6]">
            CH1: <strong className="text-cyan-300 font-mono">CAN_H 3.50V</strong>
          </span>
          <span className="text-[#9099A6]">
            CH2: <strong className="text-emerald-400 font-mono">CAN_L 1.50V</strong>
          </span>
          <span className="text-[#9099A6] hidden sm:inline">
            DIFF: <strong className="text-[#E6EDF5]">2.00V (RECESSIVE 0V)</strong>
          </span>
        </div>
        <div className="flex items-center gap-3 text-[#9099A6]">
          <span>500ns / div</span>
          <span className="text-cyan-400 border border-cyan-500/30 px-1.5 py-0.2 rounded bg-cyan-950/40">
            BRS 2.0M ARMED
          </span>
        </div>
      </div>

      {/* Center Stage: REAL Differential SVG Waveforms -> Center Logo -> Right Decoded Stream */}
      <div className="relative z-20 flex items-center justify-between gap-6 my-auto">
        {/* Left Side: Real SVG Differential Square Wave Coupling directly into Logo */}
        <div className="flex-1 flex flex-col justify-center gap-2 overflow-hidden pr-1">
          {/* CAN_H Differential Line */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-cyan-400 shrink-0 font-bold w-12">CAN_H</span>
            <svg
              className="flex-1 h-[22px] overflow-visible"
              viewBox="0 0 160 22"
              preserveAspectRatio="none"
              fill="none"
            >
              {/* Underlying static guide trace */}
              <path
                d="M 0 14 H 28 V 5 H 56 V 14 H 84 V 3 H 116 V 14 H 160"
                stroke="#0E7490"
                strokeWidth="1.2"
                strokeOpacity="0.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Traveling high-speed optical beam */}
              <path
                d="M 0 14 H 28 V 5 H 56 V 14 H 84 V 3 H 116 V 14 H 160"
                stroke="#00D8FF"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={100}
                strokeDasharray="14 26"
                className="animate-[nexusBeamFlow_1.6s_linear_infinite]"
                filter="url(#nexusGlowFilter)"
              />
            </svg>
          </div>

          {/* CAN_L Complementary Differential Line */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-emerald-400 shrink-0 font-bold w-12">CAN_L</span>
            <svg
              className="flex-1 h-[22px] overflow-visible"
              viewBox="0 0 160 22"
              preserveAspectRatio="none"
              fill="none"
            >
              {/* Underlying static guide trace */}
              <path
                d="M 0 8 H 28 V 17 H 56 V 8 H 84 V 19 H 116 V 8 H 160"
                stroke="#0E7490"
                strokeWidth="1.2"
                strokeOpacity="0.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Traveling high-speed optical beam */}
              <path
                d="M 0 8 H 28 V 17 H 56 V 8 H 84 V 19 H 116 V 8 H 160"
                stroke="#10E88A"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={100}
                strokeDasharray="14 26"
                className="animate-[nexusBeamFlow_1.6s_linear_infinite]"
                filter="url(#nexusGlowFilter)"
              />
            </svg>
          </div>
        </div>

        {/* Center: Glowing NexusCAN Official Vector Logo */}
        <div className="relative flex flex-col items-center shrink-0">
          <div className="relative p-2 rounded-lg bg-[#0B0F17]/95 border border-cyan-500/50 shadow-[0_0_28px_rgba(6,182,212,0.24)]">
            <NexusCanVectorLogo size={84} glow={true} replayNonce={replayNonce} animated={true} />
          </div>
        </div>

        {/* Right Side: Decoded Physical Frame Packets + Stream Exit */}
        <div className="flex-1 flex flex-col justify-center gap-2 pl-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {DECODED_BADGES.map((b, idx) => (
              <span
                key={`badge-${idx}-${replayNonce}`}
                style={{
                  clipPath: 'inset(0 100% 0 0)',
                  animation: `nexusBarReveal 0.28s var(--ease-out) ${idx * 40 + 160}ms forwards`,
                }}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${b.cls}`}
              >
                {b.label}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2 text-[11px] font-mono text-[#9099A6]">
            <span className="text-emerald-400 font-bold">PHASE LOCK:</span>
            <span>0.00° / ZERO HORIZONTAL JITTER</span>
          </div>
        </div>
      </div>

      {/* Bottom Brand Bar with Shimmer Reveal */}
      <div className="relative z-20 flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#0E7490]/30 text-[11px]">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[17px] font-bold tracking-tight text-[#E6EDF5] font-sans">
            NexusCAN
          </h1>
          <span className="px-2 py-0.5 border border-emerald-500/40 bg-emerald-950/40 text-emerald-400 font-mono text-[10px] font-bold rounded-sm">
            v1.0 INDUSTRIAL
          </span>
          <span className="text-[11px] text-[#9099A6] hidden md:inline">
            Deterministic Multi-Bus CAN / CAN-FD Analyzer & 60 FPS Telemetry
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-cyan-400/90">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span>SYNC: 16.6ms CLOCK</span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 3. CONCEPT 02: SILICON ECU (OTOMOTİV QFN ÇİP & 45° PCB VERİ YOLU)
// ============================================================================
interface ConceptSiliconEcuProps {
  replayNonce: number;
}

const ConceptSiliconEcu: React.FC<ConceptSiliconEcuProps> = ({ replayNonce }) => {
  return (
    <div className="relative w-full h-[220px] rounded-lg overflow-hidden border border-[#0E7490]/50 bg-[#070A0F] flex flex-col justify-between p-4 select-none">
      {/* PCB Solder Mask & 45-Degree Copper Traces Background */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-30">
        <defs>
          <pattern id="pcbDots" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="8" cy="8" r="0.6" fill="#0E7490" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#pcbDots)" />
        {/* PCB Silkscreen Labels & Alignment Marks */}
        <text x="18" y="24" fill="#0E7490" fontSize="9" fontFamily="monospace">CAN-FD PHY · ISO 11898-2</text>
        <text x="18" y="38" fill="#144B5B" fontSize="8" fontFamily="monospace">LAYER 1: DIFF MICROSTRIP</text>
        <text x="18" y="196" fill="#144B5B" fontSize="8" fontFamily="monospace">Z0_DIFF: 120Ω ± 1%</text>

        {/* 45-degree angle copper bus traces */}
        <g stroke="#0E7490" strokeWidth="1.2" fill="none">
          <path d="M 0 60 L 140 60 L 180 100 L 250 100" />
          <path d="M 0 74 L 135 74 L 175 114 L 250 114" />
          <path d="M 520 100 L 600 100 L 640 60 L 900 60" />
          <path d="M 520 114 L 595 114 L 635 74 L 900 74" />
        </g>

        {/* Dynamic flowing light packets over the 45° copper traces */}
        <g fill="none">
          <path
            d="M 0 60 L 140 60 L 180 100 L 250 100"
            stroke="#00D8FF"
            strokeWidth="1.8"
            pathLength={100}
            strokeDasharray="12 36"
            className="animate-[nexusBeamFlow_1.6s_linear_infinite]"
          />
          <path
            d="M 0 74 L 135 74 L 175 114 L 250 114"
            stroke="#10E88A"
            strokeWidth="1.8"
            pathLength={100}
            strokeDasharray="12 36"
            className="animate-[nexusBeamFlow_1.6s_linear_infinite]"
          />
          <path
            d="M 520 100 L 600 100 L 640 60 L 900 60"
            stroke="#00D8FF"
            strokeWidth="1.8"
            pathLength={100}
            strokeDasharray="12 36"
            className="animate-[nexusBeamFlow_1.6s_linear_infinite]"
          />
          <path
            d="M 520 114 L 595 114 L 635 74 L 900 74"
            stroke="#10E88A"
            strokeWidth="1.8"
            pathLength={100}
            strokeDasharray="12 36"
            className="animate-[nexusBeamFlow_1.6s_linear_infinite]"
          />
        </g>

        {/* Via drill holes */}
        <circle cx="180" cy="100" r="3.2" stroke="#00D8FF" strokeWidth="1" fill="#0B0F17" />
        <circle cx="175" cy="114" r="3.2" stroke="#10E88A" strokeWidth="1" fill="#0B0F17" />
        <circle cx="640" cy="60" r="3.2" stroke="#00D8FF" strokeWidth="1" fill="#0B0F17" />
        <circle cx="635" cy="74" r="3.2" stroke="#10E88A" strokeWidth="1" fill="#0B0F17" />
      </svg>

      {/* Top Header: Automotive Spec Badges */}
      <div className="relative z-20 flex items-center justify-between text-[10px] font-mono pb-1 border-b border-[#0E7490]/30">
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded bg-[#10151E] border border-cyan-500/40 text-cyan-300 font-bold">
            AEC-Q100 GRADE 0
          </span>
          <span className="text-[#9099A6] hidden sm:inline">
            AUTOMOTIVE MULTI-BUS CAN / CAN-FD TRANSCEIVER
          </span>
        </div>
        <div className="flex items-center gap-3 text-[#9099A6]">
          <span>Z0: 120Ω TERMINATED</span>
          <span className="text-emerald-400 font-bold">PASSIVE DIN-ISO</span>
        </div>
      </div>

      {/* Center Layout: Left Copper Bus -> Transceiver QFN Chip -> Telemetry Specs */}
      <div className="relative z-20 flex items-center justify-between gap-6 my-auto">
        {/* Left: Microstrip Differential Input */}
        <div className="flex-1 hidden sm:flex flex-col gap-2">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#9099A6]">
            <span>BUS 1..8 HAL</span>
            <span className="text-cyan-400 font-bold">gs_usb / SocketCAN</span>
          </div>
          <div className="p-2 rounded bg-[#0A0E14] border border-[#0E7490]/30 font-mono text-[10px] text-[#D8DEE6] space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Payload:</span>
              <span className="text-cyan-300 font-bold">0..64 Bytes (CAN-FD)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Bitrate:</span>
              <span className="text-emerald-300 font-bold">500k Nom / 2M Data</span>
            </div>
          </div>
        </div>

        {/* Center: QFN-32 Micro-Transceiver Chip with NexusCAN Vector Logo */}
        <div className="relative shrink-0 flex flex-col items-center">
          <div className="p-3 rounded-lg bg-[#070B10] border-2 border-cyan-500/50 shadow-[0_0_28px_rgba(0,216,255,0.22)]">
            <NexusCanVectorLogo size={84} chipPins={true} glow={true} replayNonce={replayNonce} animated={true} />
          </div>
          <span className="text-[9px] font-mono tracking-widest text-cyan-400 mt-1 font-bold">
            NEXUS-PHY · QFN-32
          </span>
        </div>

        {/* Right: Strict Engineering Invariants */}
        <div className="flex-1 flex flex-col gap-1.5 font-mono text-[11px]">
          <div className="p-1.5 rounded bg-cyan-950/30 border border-cyan-500/30 flex items-center justify-between">
            <span className="text-cyan-300 font-bold">80B ZERO-ALLOC</span>
            <span className="text-[10px] text-cyan-400/80">Stack RawCanFrame</span>
          </div>
          <div className="p-1.5 rounded bg-emerald-950/30 border border-emerald-500/30 flex items-center justify-between">
            <span className="text-emerald-300 font-bold">&lt;1µs HW JITTER</span>
            <span className="text-[10px] text-emerald-400/80">SO_TIMESTAMPING</span>
          </div>
          <div className="p-1.5 rounded bg-slate-900/60 border border-slate-700 flex items-center justify-between">
            <span className="text-slate-200 font-bold">LISTEN-ONLY SAFE</span>
            <span className="text-[10px] text-emerald-400 font-bold">Default Passive</span>
          </div>
        </div>
      </div>

      {/* Bottom Brand Bar */}
      <div className="relative z-20 flex items-center justify-between pt-2 border-t border-[#0E7490]/30 text-[11px]">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[17px] font-bold tracking-tight text-[#E6EDF5] font-sans">
            NexusCAN
          </h1>
          <span className="px-2 py-0.5 border border-cyan-500/40 bg-cyan-950/40 text-cyan-300 font-mono text-[10px] font-bold rounded-sm">
            HARDWARE LEVEL
          </span>
          <span className="text-[11px] text-[#9099A6] hidden md:inline">
            Universal Hardware Abstraction Layer for Automotive & Embedded Bus Interfaces
          </span>
        </div>
        <span className="font-mono text-[10px] text-[#9099A6]">
          CLK: 80 MHz CRYSTAL
        </span>
      </div>
    </div>
  );
};

// ============================================================================
// 4. CONCEPT 03: EYE DIAGRAM (GENUINE 8-TRANSITION CAN-FD EYE PATTERN)
// ============================================================================
interface ConceptEyeDiagramProps {
  replayNonce: number;
}

// 8 classic 3-bit transitions for standard eye diagram test:
// [b0, b1, b2] where b ∈ {0: dominant, 1: recessive}
const THREE_BIT_TRANSITIONS: readonly [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 1],
  [0, 1, 0],
  [0, 1, 1],
  [1, 0, 0],
  [1, 0, 1],
  [1, 1, 0],
  [1, 1, 1],
];

const ConceptEyeDiagram: React.FC<ConceptEyeDiagramProps> = ({ replayNonce }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let frameCount = 0;

    const isReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const renderEye = () => {
      frameCount += 1;
      const w = canvas.width;
      const h = canvas.height;
      const centerY = h / 2;
      const bitHeight = 44; // eye opening vertical span

      // Phosphor persistence decay trail
      ctx.fillStyle = 'rgba(7, 10, 15, 0.24)';
      ctx.fillRect(0, 0, w, h);

      // 1. Draw Eye Mask Boundaries (Standard Diamond Mask in Amber)
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.40)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      // Center eye opening diamond
      const maskCenter = w * 0.50;
      const maskW = 70;
      const maskH = 22;
      ctx.moveTo(maskCenter - maskW, centerY);
      ctx.lineTo(maskCenter, centerY - maskH);
      ctx.lineTo(maskCenter + maskW, centerY);
      ctx.lineTo(maskCenter, centerY + maskH);
      ctx.closePath();
      ctx.stroke();

      // 2. Vertical 80.0% Sample Point marker
      const sampleX = maskCenter + 28;
      ctx.strokeStyle = 'rgba(16, 232, 138, 0.55)';
      ctx.beginPath();
      ctx.moveTo(sampleX, 12);
      ctx.lineTo(sampleX, h - 12);
      ctx.stroke();
      ctx.setLineDash([]);

      // 3. Draw All 8 CAN-FD Bit Transitions across Bit Boundaries (-0.5T, 0T, +0.5T)
      const t = frameCount * 0.05;

      for (let i = 0; i < THREE_BIT_TRANSITIONS.length; i++) {
        const [b0, b1, b2] = THREE_BIT_TRANSITIONS[i];
        const isTransition = b0 !== b1 || b1 !== b2;

        ctx.strokeStyle = isTransition
          ? i % 2 === 0
            ? 'rgba(0, 216, 255, 0.52)'
            : 'rgba(16, 232, 138, 0.48)'
          : 'rgba(14, 116, 144, 0.32)';

        ctx.lineWidth = isTransition ? 1.8 : 1.2;
        ctx.beginPath();

        const x1 = w * 0.28;
        const x2 = w * 0.72;

        for (let x = 0; x < w; x += 3) {
          // Low-pass filtered tanh step response
          const step1 = (1 + Math.tanh((x - x1) / 18)) * 0.5;
          const step2 = (1 + Math.tanh((x - x2) / 18)) * 0.5;

          const bitLevel = b0 + (b1 - b0) * step1 + (b2 - b1) * step2;
          const normLevel = (bitLevel - 0.5) * 2; // -1 to +1

          // Subtle realistic edge jitter
          const jitter = Math.sin(x * 0.08 + t + i) * 1.5;
          const y = centerY + normLevel * bitHeight + jitter;

          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      if (!isReducedMotion) {
        animId = requestAnimationFrame(renderEye);
      }
    };

    renderEye();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [replayNonce]);

  return (
    <div className="relative w-full h-[220px] rounded-lg overflow-hidden border border-[#0E7490]/50 bg-[#070A0F] flex flex-col justify-between p-4 select-none">
      {/* 60 FPS HTML5 Canvas Eye Diagram */}
      <canvas
        ref={canvasRef}
        width={780}
        height={220}
        className="absolute inset-0 w-full h-full pointer-events-none opacity-45"
      />

      {/* Top Eye Diagram HUD */}
      <div className="relative z-20 flex items-center justify-between text-[10px] font-mono pb-1 border-b border-[#0E7490]/30">
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/40 text-emerald-400 font-bold">
            MASK TEST: PASS (0 VIOLATIONS)
          </span>
          <span className="text-[#9099A6] hidden sm:inline">
            CAN-FD PHYSICAL LAYER EYE CONVERGENCE
          </span>
        </div>
        <div className="flex items-center gap-3 text-[#9099A6]">
          <span>SAMPLE POINT: <strong className="text-emerald-400">80.0%</strong></span>
          <span>JITTER RMS: <strong className="text-cyan-300">3.8 ns</strong></span>
        </div>
      </div>

      {/* Center Hero Overlay: Official Vector Logo + High-Impact Telemetry Metrics */}
      <div className="relative z-20 flex items-center justify-between gap-6 my-auto">
        <div className="flex items-center gap-4">
          <div className="p-2 rounded-lg bg-[#0B0F17]/90 border border-cyan-500/40 shadow-[0_0_24px_rgba(6,182,212,0.2)]">
            <NexusCanVectorLogo size={84} glow={true} replayNonce={replayNonce} animated={true} />
          </div>
          <div>
            <h1 className="text-[20px] font-bold text-[#E6EDF5] tracking-tight font-sans">
              NexusCAN
            </h1>
            <p className="text-[11px] text-[#9099A6] font-mono mt-0.5">
              Deterministic 60 FPS Canvas Telemetry Engine
            </p>
          </div>
        </div>

        {/* Eye Quality Readout Cards */}
        <div className="hidden sm:flex items-center gap-2 font-mono text-[10px]">
          <div className="p-2 rounded bg-[#090D14]/90 border border-[#0E7490]/40 flex flex-col items-center w-24">
            <span className="text-[#9099A6]">EYE HEIGHT</span>
            <span className="text-cyan-300 font-bold text-[13px] mt-0.5">1.85 V</span>
            <span className="text-emerald-400 text-[9px] mt-0.5">NOMINAL &gt;1.5V</span>
          </div>
          <div className="p-2 rounded bg-[#090D14]/90 border border-[#0E7490]/40 flex flex-col items-center w-24">
            <span className="text-[#9099A6]">EYE WIDTH</span>
            <span className="text-emerald-300 font-bold text-[13px] mt-0.5">420 ns</span>
            <span className="text-cyan-400 text-[9px] mt-0.5">84% UI TIME</span>
          </div>
        </div>
      </div>

      {/* Bottom Brand Bar */}
      <div className="relative z-20 flex items-center justify-between pt-2 border-t border-[#0E7490]/30 text-[11px]">
        <div className="flex items-center gap-2.5">
          <span className="px-2 py-0.5 border border-emerald-500/40 bg-emerald-950/40 text-emerald-400 font-mono text-[10px] font-bold rounded-sm">
            BIT-TIMING CERTIFIED
          </span>
          <span className="text-[11px] text-[#9099A6] hidden md:inline">
            Zero WebGL / Canvas CPU Leaks — Guaranteed 60 FPS Render Pipeline
          </span>
        </div>
        <span className="font-mono text-[10px] text-cyan-400/90">
          60.0 FPS LOCKED
        </span>
      </div>
    </div>
  );
};

// ============================================================================
// 5. CONCEPT 04: TACTICAL BOOT (PALANTIR / MOTORSPORT ENSTRÜMAN AÇILIŞI)
// ============================================================================
interface ConceptTacticalBootProps {
  replayNonce: number;
}

const ConceptTacticalBoot: React.FC<ConceptTacticalBootProps> = ({ replayNonce }) => {
  const [bootStep, setBootStep] = useState<number>(3);

  useEffect(() => {
    setBootStep(0);
    const t1 = setTimeout(() => setBootStep(1), 90);
    const t2 = setTimeout(() => setBootStep(2), 240);
    const t3 = setTimeout(() => setBootStep(3), 390);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [replayNonce]);

  return (
    <div className="relative w-full h-[220px] rounded-lg overflow-hidden border border-[#0E7490]/50 bg-[#06090E] flex flex-col justify-between p-4 select-none">
      {/* Aerospace Precision Corner Brackets */}
      <div className="absolute top-2 left-2 text-[#00D8FF] font-mono text-[12px] pointer-events-none select-none">┌</div>
      <div className="absolute top-2 right-2 text-[#00D8FF] font-mono text-[12px] pointer-events-none select-none">┐</div>
      <div className="absolute bottom-2 left-2 text-[#00D8FF] font-mono text-[12px] pointer-events-none select-none">└</div>
      <div className="absolute bottom-2 right-2 text-[#00D8FF] font-mono text-[12px] pointer-events-none select-none">┘</div>

      {/* Laser Calibration Scan Line (Sweeps across the full 220px container height!) */}
      <div
        key={`laser-${replayNonce}`}
        className="absolute left-0 right-0 h-[1.5px] bg-gradient-to-r from-transparent via-[#00D8FF] to-transparent pointer-events-none opacity-80 animate-[nexusLaserSweep_1.8s_var(--ease-out)_infinite]"
      />

      {/* Top Header: Mission Critical Ready State */}
      <div className="relative z-20 flex items-center justify-between text-[10px] font-mono pb-1 border-b border-[#0E7490]/30">
        <div className="flex items-center gap-2">
          <span className="text-cyan-400 font-bold">[SYS_INIT: OK]</span>
          <span className="text-[#9099A6]">
            PALANTIR & MOTORSPORT TELEMETRY ARCHITECTURE
          </span>
        </div>
        <div className="flex items-center gap-2 text-emerald-400 font-bold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
          <span>ALL CHANNELS NOMINAL</span>
        </div>
      </div>

      {/* Center Layout: Laser-Scanned Logo + Staggered Subsystem Verification Ticker */}
      <div className="relative z-20 flex items-center justify-between gap-6 my-auto">
        <div className="flex items-center gap-4">
          <div className="p-2 rounded-lg bg-[#0A0E15] border border-cyan-500/40 shadow-[0_0_24px_rgba(6,182,212,0.18)]">
            <NexusCanVectorLogo size={84} glow={true} replayNonce={replayNonce} animated={true} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1
                key={`title-${replayNonce}`}
                className="text-[20px] font-bold text-[#E6EDF5] tracking-tight font-sans animate-[nexusShimmerSweep_0.6s_var(--ease-out)_forwards]"
              >
                NexusCAN
              </h1>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-950/60 border border-cyan-500/40 text-cyan-300 font-bold">
                CORE v1.0
              </span>
            </div>
            <p className="text-[11px] text-[#9099A6] font-mono mt-0.5">
              Deterministic Multi-Bus CAN / CAN-FD Industrial Telemetry
            </p>
          </div>
        </div>

        {/* 3-Stage Readiness Ticker */}
        <div className="flex flex-col gap-1.5 font-mono text-[10px]">
          <div
            className={`px-2 py-1 rounded border transition-all duration-200 ${
              bootStep >= 1
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}
          >
            [OK] 01 · NETDB COMPILER: DBC / KCD MATRIX MOUNTED
          </div>
          <div
            className={`px-2 py-1 rounded border transition-all duration-200 ${
              bootStep >= 2
                ? 'bg-cyan-950/40 border-cyan-500/40 text-cyan-300'
                : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}
          >
            [OK] 02 · 60HZ TELEMETRY ENGINE: TWO-PLANE IPC LOCKED
          </div>
          <div
            className={`px-2 py-1 rounded border transition-all duration-200 ${
              bootStep >= 3
                ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}
          >
            [OK] 03 · LISTEN-ONLY SAFETY GUARD: ACTIVE BUS ARMED
          </div>
        </div>
      </div>

      {/* Bottom Brand Bar */}
      <div className="relative z-20 flex items-center justify-between pt-2 border-t border-[#0E7490]/30 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-cyan-400 font-bold">CALIBRATION ID:</span>
          <span className="text-[10px] font-mono text-slate-400">0xDEAD_BEEF_CAN_FD</span>
        </div>
        <span className="font-mono text-[10px] text-emerald-400">
          READY FOR LIVE INGESTION
        </span>
      </div>
    </div>
  );
};

// ============================================================================
// 6. MAIN HERO SHOWCASE CONTAINER WITH LIVE CONCEPT SWITCHER
// ============================================================================
export const StartHeroShowcase: React.FC = () => {
  const [activeConcept, setActiveConcept] = useState<HeroConceptId>(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(LOCAL_STORAGE_KEY) as HeroConceptId | null;
      if (saved && (saved === '01' || saved === '02' || saved === '03' || saved === '04')) {
        return saved;
      }
    }
    return '01';
  });

  const [replayNonce, setReplayNonce] = useState<number>(0);

  const handleSelectConcept = (id: HeroConceptId) => {
    setActiveConcept(id);
    setReplayNonce((prev) => prev + 1);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, id);
    }
  };

  const handleReplay = () => {
    setReplayNonce((prev) => prev + 1);
  };

  return (
    <div className="w-full flex flex-col gap-2">
      {/* Top Concept Switcher Toolbar */}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1 text-[var(--text-secondary)]">
          <span className="font-mono text-[10px] text-cyan-400 uppercase tracking-wider font-semibold">
            Hero Concept:
          </span>
          <span className="font-medium text-[var(--text-primary)]">
            {CONCEPTS.find((c) => c.id === activeConcept)?.label}
          </span>
        </div>

        {/* 4 Concept Buttons + Replay */}
        <div className="flex items-center gap-1">
          {CONCEPTS.map((c) => {
            const isSelected = c.id === activeConcept;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => handleSelectConcept(c.id)}
                title={c.description}
                style={{
                  backgroundColor: isSelected ? 'rgba(6, 182, 212, 0.16)' : 'var(--bg-panel)',
                  borderColor: isSelected ? '#00D8FF' : 'var(--border-strong)',
                  color: isSelected ? '#00D8FF' : 'var(--text-secondary)',
                }}
                className={`h-[22px] px-2 border rounded font-mono text-[10px] font-bold cursor-pointer transition-colors duration-150 ${
                  isSelected ? 'shadow-[0_0_8px_rgba(6,182,212,0.25)]' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {c.id}
              </button>
            );
          })}

          <div className="h-3.5 w-[1px] bg-[var(--border-strong)] mx-1" />

          {/* Replay Animation Button */}
          <button
            type="button"
            onClick={handleReplay}
            title="Replay Entrance Animation Sequence"
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[22px] px-2 border rounded flex items-center gap-1 text-[10px] font-mono font-medium hover:border-cyan-400 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3 h-3 text-cyan-400" />
            <span>Replay</span>
          </button>
        </div>
      </div>

      {/* Dynamic Active Hero Concept Scene */}
      <div className="w-full">
        {activeConcept === '01' && <ConceptSignalLock replayNonce={replayNonce} />}
        {activeConcept === '02' && <ConceptSiliconEcu replayNonce={replayNonce} />}
        {activeConcept === '03' && <ConceptEyeDiagram replayNonce={replayNonce} />}
        {activeConcept === '04' && <ConceptTacticalBoot replayNonce={replayNonce} />}
      </div>
    </div>
  );
};
