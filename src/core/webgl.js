/**
 * Whether this machine can render WebGL — asked without importing a renderer.
 *
 * Kept in its own module deliberately: the 3D core pulls in Three.js, and the
 * decision about whether to load that at all has to be made before the import.
 */
export function supportsWebGL() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
