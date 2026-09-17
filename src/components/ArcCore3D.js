import * as THREE from 'three';
import { Component } from '../core/component.js';
import { store, MODE } from '../core/store.js';
import { bus } from '../core/bus.js';
import { palette } from '../core/theme.js';
import { telemetry } from '../core/telemetry.js';
import { prefersReducedMotion } from '../core/ticker.js';
import { approach, clamp } from '../core/format.js';

const TAU = Math.PI * 2;

/**
 * The reactor core in three dimensions.
 *
 * Same instrument as the 2D core and driven by exactly the same state — the
 * rings take their speed and hue from the mode, two of them are the live CPU
 * and memory traces, and the centre swells with the speech envelope. Depth is
 * the only thing added: the rings sit on different planes and the whole
 * assembly leans towards the pointer, so it reads as a housing rather than a
 * diagram.
 *
 * Everything is `MeshBasicMaterial` with additive blending. That sidesteps
 * lighting and colour-space entirely, costs a fraction of a post-processing
 * bloom chain, and keeps the glow looking like the rest of the HUD.
 */
export class ArcCore3D extends Component {
  render() {
    this.canvas = this.$('canvas');
    this.reduced = prefersReducedMotion;
    this.spin = 0;
    this.energy = 0.4;
    this.pulse = 0;
    this.tilt = { x: 0, y: 0 };
    this.target = { x: 0, y: 0 };
    this.ripples = [];
    this.mode = MODE.IDLE;
    this.lost = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
    });
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(0, 0, 7.4);

    this.assembly = new THREE.Group();
    this.scene.add(this.assembly);

    this.buildRings();
    this.buildCore();
    this.buildMotes();

    // A lost context is not hypothetical on a laptop that sleeps or switches
    // GPUs. Fall back rather than leaving a black square where the core was.
    this.listen(this.canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
      bus.emit('log', {
        level: 'warn',
        tag: 'core',
        text: 'Reactor render context lost — falling back to the flat core.',
      });
      bus.emit('core:fallback');
    });

    this.listen(this.canvas, 'pointerdown', () => bus.emit('core:pulse', { strength: 1 }));
    this.listen(this.el, 'pointermove', (event) => {
      const box = this.el.getBoundingClientRect();
      this.target.y = ((event.clientX - box.left) / box.width - 0.5) * 0.5;
      this.target.x = ((event.clientY - box.top) / box.height - 0.5) * 0.4;
    });
    this.listen(this.el, 'pointerleave', () => { this.target.x = 0; this.target.y = 0; });

    this.watch('mode', (mode) => {
      this.mode = mode;
      this.ripples.push({ scale: 0.7, life: 1 });
    });
    this.on('core:pulse', ({ strength = 1 }) => {
      this.pulse = Math.min(1, this.pulse + strength * 0.6);
      this.ripples.push({ scale: 0.6, life: 1 });
    });

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(this.el);
    this.track(() => observer.disconnect());
    this.resize();

    this.animate((dt, elapsed) => this.frame(dt, elapsed));
    this.track(() => this.dispose());
  }

  /** Register a geometry/material for disposal without a separate bookkeeping pass. */
  own(object) {
    (this._owned ||= []).push(object);
    return object;
  }

  line(color, opacity) {
    return this.own(new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
  }

  buildRings() {
    this.rings = [];
    // radius, tube, tilt, speed, opacity
    const specs = [
      [2.5, 0.012, [0, 0, 0], 0.34, 0.55],
      [2.2, 0.02, [Math.PI / 2.6, 0, 0], -0.22, 0.7],
      [1.85, 0.01, [0, Math.PI / 2.8, 0], 0.46, 0.45],
      [1.55, 0.026, [Math.PI / 3.4, Math.PI / 5, 0], -0.3, 0.8],
    ];
    for (const [radius, tube, rot, speed, opacity] of specs) {
      const mesh = new THREE.Mesh(
        this.own(new THREE.TorusGeometry(radius, tube, 8, 160)),
        this.line(0x00f3ff, opacity),
      );
      mesh.rotation.set(...rot);
      mesh.userData = { speed, base: rot };
      this.assembly.add(mesh);
      this.rings.push(mesh);
    }

    // The two live metric arcs. `thetaLength` is rewritten each frame, so the
    // geometry is rebuilt rather than scaled — cheap at this segment count.
    this.arcs = [0, 1].map((i) => {
      const mesh = new THREE.Mesh(
        this.own(new THREE.RingGeometry(1.95 + i * 0.18, 2.0 + i * 0.18, 96, 1, 0, Math.PI)),
        this.line(i ? 0x0066ff : 0x00f3ff, 0.9),
      );
      mesh.rotation.z = i ? Math.PI * 0.35 : -Math.PI * 0.75;
      this.assembly.add(mesh);
      return mesh;
    });

    // Twelve calibration ticks, as one instanced batch rather than twelve meshes.
    const tick = this.own(new THREE.BoxGeometry(0.055, 0.14, 0.012));
    this.ticks = new THREE.InstancedMesh(tick, this.line(0x00f3ff, 0.5), 36);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 36; i += 1) {
      const a = (i / 36) * TAU;
      m.makeRotationZ(a);
      m.setPosition(Math.cos(a) * 2.75, Math.sin(a) * 2.75, 0);
      this.ticks.setMatrixAt(i, m);
    }
    this.ticks.instanceMatrix.needsUpdate = true;
    this.assembly.add(this.ticks);
  }

  buildCore() {
    this.core = new THREE.Group();
    this.assembly.add(this.core);

    this.shell = new THREE.Mesh(
      this.own(new THREE.IcosahedronGeometry(0.78, 1)),
      this.own(new THREE.MeshBasicMaterial({
        color: 0x00f3ff,
        wireframe: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })),
    );
    this.core.add(this.shell);

    this.heart = new THREE.Mesh(
      this.own(new THREE.SphereGeometry(0.42, 32, 24)),
      this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 })),
    );
    this.core.add(this.heart);

    // The reactor triangle, edge-on to the camera like the 2D core's motif.
    const tri = new THREE.Mesh(
      this.own(new THREE.CircleGeometry(0.62, 3)),
      this.line(0xffffff, 0.5),
    );
    tri.position.z = 0.02;
    this.triangle = tri;
    this.core.add(tri);

    // Radial bloom: a big additive disc reading as light rather than geometry.
    this.bloom = new THREE.Mesh(
      this.own(new THREE.PlaneGeometry(6, 6)),
      this.own(new THREE.MeshBasicMaterial({
        map: this.own(glowTexture()),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })),
    );
    this.scene.add(this.bloom);
  }

  /** Drifting motes, so the housing sits in a volume rather than a vacuum. */
  buildMotes() {
    const count = 260;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 1.4 + Math.random() * 2.4;
      const theta = Math.random() * TAU;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      positions[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * r;
      positions[i * 3 + 2] = Math.cos(phi) * r * 0.5;
    }
    const geo = this.own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.motes = new THREE.Points(
      geo,
      this.own(new THREE.PointsMaterial({
        color: 0x00f3ff,
        size: 0.028,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })),
    );
    this.assembly.add(this.motes);
  }

  resize() {
    const box = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    if (w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Hue and rotation rate for the current state — the 2D core's rules, in 3D. */
  get scheme() {
    if (store.get('threat') === 'critical') return { key: palette.alert, speed: 2.4 };
    switch (this.mode) {
      case MODE.LISTENING: return { key: palette.hud, speed: 1.1 };
      case MODE.PROCESSING: return { key: palette.arc, speed: 3.1 };
      case MODE.SPEAKING: return { key: palette.hud, speed: 1.6 };
      default: return { key: palette.hud, speed: 0.55 };
    }
  }

  frame(dt, elapsed) {
    if (this.lost) return;
    const { scheme } = this;
    const amplitude = store.get('amplitude');

    this.energy = approach(
      this.energy,
      clamp(0.32 + amplitude * 0.85 + (this.mode === MODE.PROCESSING ? 0.35 : 0), 0, 1.4),
      dt,
      8,
    );
    this.pulse = approach(this.pulse, amplitude * 0.7, dt, 4);

    const rate = this.reduced ? 0.15 : 1;
    this.spin += dt * scheme.speed * 0.32 * rate;

    const key = new THREE.Color(scheme.key);
    const accent = new THREE.Color(palette.arc);

    for (const ring of this.rings) {
      ring.rotation.z = ring.userData.base[2] + this.spin * ring.userData.speed * 3;
      ring.material.color.copy(key);
    }
    this.ticks.rotation.z = this.spin * 0.25;
    this.ticks.material.color.copy(key);

    // Live CPU and memory as swept arcs.
    const cpu = (telemetry.get('cpu')?.value ?? 40) / 100;
    const mem = (telemetry.get('mem')?.value ?? 55) / 100;
    this.sweep(this.arcs[0], 1.95, 2.0, clamp(cpu, 0.02, 1) * Math.PI * 1.1);
    this.sweep(this.arcs[1], 2.13, 2.18, clamp(mem, 0.02, 1) * Math.PI * 1.1);
    this.arcs[0].material.color.copy(key);
    this.arcs[1].material.color.copy(accent);

    // Lean towards the pointer.
    this.tilt.x = approach(this.tilt.x, this.target.x, dt, 4);
    this.tilt.y = approach(this.tilt.y, this.target.y, dt, 4);
    this.assembly.rotation.x = this.tilt.x;
    this.assembly.rotation.y = this.tilt.y;

    const swell = 1 + this.pulse * 0.22 + Math.sin(elapsed * 1.6) * 0.014;
    this.core.scale.setScalar(swell);
    this.shell.rotation.y += dt * 0.5 * rate;
    this.shell.rotation.x += dt * 0.22 * rate;
    this.shell.material.color.copy(key);
    this.triangle.rotation.z = -this.spin * 0.7;
    this.heart.scale.setScalar(1 + amplitude * 0.45);
    this.heart.material.opacity = 0.75 + amplitude * 0.25;

    this.motes.rotation.z += dt * 0.06 * rate;
    this.motes.material.color.copy(key);
    this.motes.material.opacity = 0.35 + this.energy * 0.3;

    this.bloom.material.color.copy(key);
    this.bloom.material.opacity = 0.3 + this.energy * 0.35 + this.pulse * 0.25;

    this.stepRipples(dt, key);
    this.renderer.render(this.scene, this.camera);
  }

  /** Rewrite an arc's sweep in place. */
  sweep(mesh, inner, outer, theta) {
    if (Math.abs((mesh.userData.theta ?? -1) - theta) < 0.01) return;
    mesh.userData.theta = theta;
    mesh.geometry.dispose();
    mesh.geometry = new THREE.RingGeometry(inner, outer, 96, 1, 0, theta);
  }

  stepRipples(dt, key) {
    this._ripplePool ||= [];
    for (const ripple of this.ripples) {
      ripple.scale += dt * 1.4;
      ripple.life -= dt * 1.15;
    }
    this.ripples = this.ripples.filter((r) => r.life > 0).slice(-5);

    while (this._ripplePool.length < this.ripples.length) {
      const mesh = new THREE.Mesh(
        this.own(new THREE.TorusGeometry(1, 0.006, 6, 96)),
        this.line(0x00f3ff, 0.4),
      );
      this.assembly.add(mesh);
      this._ripplePool.push(mesh);
    }
    this._ripplePool.forEach((mesh, i) => {
      const ripple = this.ripples[i];
      mesh.visible = Boolean(ripple);
      if (!ripple) return;
      mesh.scale.setScalar(ripple.scale);
      mesh.material.opacity = ripple.life * 0.45;
      mesh.material.color.copy(key);
    });
  }

  dispose() {
    (this._owned || []).forEach((object) => object.dispose?.());
    this._owned = [];
    this.renderer?.dispose();
  }
}

/** A soft radial falloff, generated rather than shipped as an image. */
function glowTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
