export const APP_NAME = 'GachaRecordsViewer';

/** Process liveness only; storage and upstream capability checks come later. */
export interface HealthResponse {
  status: 'ok';
  service: typeof APP_NAME;
}
