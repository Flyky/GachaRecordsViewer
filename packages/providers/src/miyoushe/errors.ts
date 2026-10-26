export type ProbeErrorCode =
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'expired'
  | 'verification_required'
  | 'auth_invalid'
  | 'upstream'
  | 'protocol'
  | 'role_required'
  | 'role_mismatch';

/** Never retain raw upstream errors, URLs, messages, headers or response bodies. */
export class ProbeError extends Error {
  constructor(
    readonly code: ProbeErrorCode,
    readonly stage: string,
    readonly upstreamCode?: number,
  ) {
    super(`Miyoushe probe: ${stage} (${code})`);
    this.name = 'ProbeError';
  }

  toJSON() {
    return {
      code: this.code,
      stage: this.stage,
      ...(this.upstreamCode === undefined ? {} : { upstreamCode: this.upstreamCode }),
    };
  }
}

export function upstreamError(stage: string, code: number): ProbeError {
  if ([-3501, -106].includes(code)) return new ProbeError('expired', stage, code);
  if (code === -3505) return new ProbeError('cancelled', stage, code);
  if ([1034, 10035, -3101].includes(code)) {
    return new ProbeError('verification_required', stage, code);
  }
  if ([-100, -101, 10001].includes(code)) return new ProbeError('auth_invalid', stage, code);
  return new ProbeError('upstream', stage, code);
}
