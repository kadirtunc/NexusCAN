/**
 * Typed wrappers of the ECU flashing IPC commands (`cmd_flash_*`, contract in `types/flash.ts`).
 *
 * Progress travels over a `tauri::ipc::Channel` (Tauri v2 desktop). The browser bridge speaks plain
 * HTTP and cannot carry a Channel, so there `cmd_flash_download` is invoked WITHOUT `onProgress`:
 * no live progress, the report is still returned when the download ends.
 */
import { Channel } from '@tauri-apps/api/core';
import { invokeCmd, isTauri, isUnknownCommandError } from './ipcClient';
import { parseFirmwareError, parseFlashError } from './flashCodec';
import { t } from '../i18n';
import type { DiagSessionConfigDto } from '../types/udsClient';
import type {
  DownloadConfigDto,
  FlashErrorDto,
  FlashImageHandleDto,
  FlashLoadImageArgs,
  FlashProgressDto,
  FlashReportDto,
} from '../types/flash';

export type FlashCallErrorKind = 'flash' | 'firmware' | 'unavailable' | 'other';

/** Normalised failure of a flash IPC call; `flash` is set for a structured `[flash]` rejection. */
export class FlashCallError extends Error {
  constructor(
    message: string,
    readonly kind: FlashCallErrorKind,
    readonly flash: FlashErrorDto | null = null,
  ) {
    super(message);
    this.name = 'FlashCallError';
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalize(e: unknown): FlashCallError {
  if (e instanceof FlashCallError) return e;
  if (isUnknownCommandError(e)) return new FlashCallError(t('flash.err.backendMissing'), 'unavailable');
  const flash = parseFlashError(e);
  if (flash !== null) return new FlashCallError(flash.message || flash.kind, 'flash', flash);
  const fw = parseFirmwareError(e);
  if (fw !== null) return new FlashCallError(fw, 'firmware');
  return new FlashCallError(errText(e), 'other');
}

export async function apiFlashLoadImage(args: FlashLoadImageArgs): Promise<FlashImageHandleDto> {
  try {
    const handle = await invokeCmd<FlashImageHandleDto>('cmd_flash_load_image', { ...args });
    if (
      !handle ||
      typeof handle.imageId !== 'string' ||
      !handle.summary ||
      !Array.isArray(handle.summary.segments)
    ) {
      throw new FlashCallError(t('flash.err.malformedHandle'), 'other');
    }
    return handle;
  } catch (e) {
    throw normalize(e);
  }
}

export async function apiFlashReleaseImage(imageId: string): Promise<void> {
  await invokeCmd<null>('cmd_flash_release_image', { imageId });
}

export async function apiFlashDownload(
  config: DiagSessionConfigDto,
  imageId: string,
  download: DownloadConfigDto,
  onProgress?: (p: FlashProgressDto) => void,
): Promise<FlashReportDto> {
  const args: Record<string, unknown> = { config, imageId, download };
  if (isTauri) {
    const channel = new Channel<FlashProgressDto>();
    channel.onmessage = (p) => onProgress?.(p);
    args['onProgress'] = channel;
  }
  try {
    return await invokeCmd<FlashReportDto>('cmd_flash_download', args);
  } catch (e) {
    throw normalize(e);
  }
}

/** Sets the backend cancel flag of the session; the running download then rejects with kind `cancelled`. */
export async function apiFlashCancel(config: DiagSessionConfigDto): Promise<void> {
  await invokeCmd<null>('cmd_flash_cancel', { config });
}
