// Production HTML receives the deployment path at runtime; Vite dev uses root.
export const basePath = document.querySelector('base[data-grv-base]')?.getAttribute('href') ?? '/';
export const appUrl = (path: string) => `${basePath}${path.replace(/^\/+/, '')}`;
