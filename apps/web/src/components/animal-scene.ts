import * as THREE from 'three';
import type { WorldAgent } from './agent-world';

export const avatarNames = ['量子机师', '霓虹游侠', '电路工程师', '暗网侦察员'];
export interface AnimalPosition {
  id: string;
  x: number;
  y: number;
  headY: number;
}

/** 原生几何体组成的像素机师；动画只消费展示状态，不驱动任务执行。 */
export function createAnimalScene(
  canvas: HTMLCanvasElement,
  callbacks: {
    select(id: string): void;
    positions(positions: AnimalPosition[]): void;
    encounterEnd(): void;
    encounterPhase(phase: 'approaching' | 'talking' | 'returning' | null): void;
    unavailable(): void;
  },
) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.32;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-6, 6, 4, -4, 0.1, 100);
  camera.position.set(3, 13, 17);
  camera.lookAt(0, 0.6, 0);
  scene.add(new THREE.HemisphereLight(0x8ec8ff, 0x0c0a14, 2.15));
  const light = new THREE.DirectionalLight(0x9defff, 2.55);
  light.position.set(-5, 10, 7);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  Object.assign(light.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
  light.shadow.normalBias = 0.04;
  light.shadow.bias = -0.0002;
  scene.add(light);
  const fill = new THREE.DirectionalLight(0xff65de, 1.7);
  fill.position.set(6, 4, -6);
  scene.add(fill);

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const glowMaterials = new Map<number, THREE.MeshStandardMaterial>();
  const material = (color: number) => {
    if (!materials.has(color))
      materials.set(
        color,
        new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.28, flatShading: true }),
      );
    return materials.get(color)!;
  };
  const glowMaterial = (color: number) => {
    if (!glowMaterials.has(color))
      glowMaterials.set(
        color,
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.1, roughness: 0.35 }),
      );
    return glowMaterials.get(color)!;
  };
  function shape(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    color: number,
    position: number[],
    scale: number[],
  ) {
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.position.set(position[0]!, position[1]!, position[2]!);
    mesh.scale.set(scale[0]!, scale[1]!, scale[2]!);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  const box = (parent: THREE.Object3D, color: number, position: number[], scale: number[]) =>
    shape(parent, cube, color, position, scale);
  const glowBox = (parent: THREE.Object3D, color: number, position: number[], scale: number[]) => {
    const mesh = new THREE.Mesh(cube, glowMaterial(color));
    mesh.position.set(position[0]!, position[1]!, position[2]!);
    mesh.scale.set(scale[0]!, scale[1]!, scale[2]!);
    parent.add(mesh);
    return mesh;
  };
  const environment = new THREE.Group();
  scene.add(environment);
  // 深色控制舱与霓虹网格保持低对比，角色状态光承担主要视觉提示。
  const platform = box(environment, 0x070910, [0, -0.23, 0], [16, 0.4, 10]);
  const floor = box(environment, 0x11151f, [0, -0.015, 0], [15.9, 0.08, 9.9]);
  const architecture = new THREE.Group();
  const floorLines = new THREE.Group();
  const stations = new THREE.Group();
  environment.add(architecture, floorLines, stations);
  const rearWall = box(architecture, 0x0d1018, [0, 1.15, 0], [16, 2.3, 0.15]);
  const wallCap = glowBox(architecture, 0x28d7ff, [0, 2.32, 0], [16, 0.025, 0.08]);
  const wallTrim = glowBox(architecture, 0x8b5cf6, [0, 0.12, 0.1], [16, 0.025, 0.03]);
  const lightStrip = glowBox(architecture, 0x28d7ff, [0, 2.12, 0.1], [15, 0.018, 0.018]);
  // 共享看板只呈现环境图形，不模拟额外运行状态。
  box(architecture, 0x080b12, [0, 1.37, 0.13], [3.4, 1.13, 0.08]);
  glowBox(architecture, 0x28d7ff, [-0.95, 1.68, 0.18], [0.9, 0.025, 0.02]);
  for (let i = 0; i < 3; i++) {
    glowBox(architecture, i === 1 ? 0xff4fd8 : 0x28d7ff, [-0.94, 1.43 - i * 0.19, 0.18], [0.09, 0.06, 0.02]);
    box(architecture, 0x243145, [-0.42, 1.43 - i * 0.19, 0.18], [0.72, 0.025, 0.02]);
    glowBox(
      architecture,
      i === 2 ? 0xffc857 : 0x6f8cff,
      [0.54 + i * 0.32, 1.17 + i * 0.08, 0.18],
      [0.18, 0.28 + i * 0.16, 0.02],
    );
  }
  function serverRack(parent: THREE.Object3D, x: number, z: number) {
    const rack = new THREE.Group();
    rack.position.set(x, 0, z);
    parent.add(rack);
    box(rack, 0x0a0d15, [0, 0.78, 0], [0.74, 1.56, 0.7]);
    for (let i = 0; i < 6; i++) {
      box(rack, 0x1a2230, [0, 0.25 + i * 0.2, 0.37], [0.58, 0.11, 0.03]);
      glowBox(rack, i % 3 === 1 ? 0xff4fd8 : 0x28d7ff, [-0.2, 0.25 + i * 0.2, 0.4], [0.055, 0.035, 0.02]);
    }
  }
  function desk(x: number, z: number) {
    const desk = new THREE.Group();
    desk.position.set(x, 0, z);
    stations.add(desk);
    box(desk, 0x1c2330, [0, 0.98, 0], [2.5, 0.1, 0.95]);
    for (const side of [-1, 1]) box(desk, 0x111722, [side * 1.05, 0.47, 0], [0.07, 0.95, 0.72]);
    box(desk, 0x080b12, [0, 1.42, -0.15], [1.08, 0.67, 0.09]);
    glowBox(desk, 0x28d7ff, [0, 1.42, -0.095], [0.94, 0.53, 0.012]);
    box(desk, 0x0b2130, [0, 1.42, -0.083], [0.84, 0.43, 0.009]);
    glowBox(desk, 0x28d7ff, [-0.18, 1.52, -0.07], [0.38, 0.025, 0.008]);
    glowBox(desk, 0xff4fd8, [-0.05, 1.4, -0.07], [0.63, 0.015, 0.008]);
    box(desk, 0x273244, [0, 1.09, -0.15], [0.11, 0.21, 0.11]);
    box(desk, 0x111722, [0, 1.05, 0.23], [0.7, 0.03, 0.23]);
    box(desk, 0x141a25, [0.95, 0.47, -0.01], [0.42, 0.87, 0.65]);
  }
  function agentZoneCenters(count: number) {
    if (!count) return [];
    const positions = [new THREE.Vector3(0, 0, count === 1 ? 0.7 : 2)];
    let remaining = count - 1;
    let ring = 0;
    let index = 1;
    const densityScale = count > 6 ? 1.25 : count > 4 ? 1.08 : 1;
    while (remaining > 0) {
      const ringCount = Math.min(5 + ring, remaining);
      const radiusX = (3.8 + ring * 2.3) * densityScale;
      const radiusZ = (3 + ring * 2) * densityScale;
      const spread = ringCount === 1 ? 0 : Math.min(2.35, 1.35 + (ringCount - 2) * 0.32);
      for (let slot = 0; slot < ringCount; slot++, index++) {
        const angle = ringCount === 1 ? -0.55 : (slot / (ringCount - 1) - 0.5) * spread;
        const jitterX = Math.sin(index * 2.43) * 0.12;
        const jitterZ = Math.cos(index * 1.77) * 0.1;
        positions.push(
          new THREE.Vector3(Math.sin(angle) * radiusX + jitterX, 0, 0.9 - Math.cos(angle) * radiusZ + jitterZ),
        );
      }
      remaining -= ringCount;
      ring++;
    }
    return positions;
  }
  let roomWidth = 16;
  let roomDepth = 10;
  let layoutKey = '';
  function layoutRoom(zoneCenters: THREE.Vector3[]) {
    const key = zoneCenters.length.toString();
    if (key === layoutKey) return;
    layoutKey = key;
    const widestCenter = Math.max(0, ...zoneCenters.map((center) => Math.abs(center.x)));
    const deepestCenter = Math.max(0, ...zoneCenters.map((center) => Math.abs(center.z)));
    roomWidth = Math.max(8.8, widestCenter * 2 + 4.8);
    roomDepth = Math.max(7.8, deepestCenter * 2 + 4.6);
    platform.scale.set(roomWidth, 0.4, roomDepth);
    floor.scale.set(roomWidth - 0.08, 0.08, roomDepth - 0.08);
    architecture.position.z = -roomDepth / 2 + 0.15;
    rearWall.scale.x = wallCap.scale.x = wallTrim.scale.x = roomWidth;
    lightStrip.scale.x = roomWidth - 1;
    // 复用几何与材质，仅在 Agent 数量变化时重排环境。
    floorLines.clear();
    stations.clear();
    for (let x = -roomWidth / 2 + 2.1; x < roomWidth / 2; x += 2.1)
      glowBox(floorLines, 0x17344a, [x, 0.03, 0], [0.018, 0.008, roomDepth - 0.1]);
    for (let z = -roomDepth / 2 + 2.1; z < roomDepth / 2; z += 2.1)
      glowBox(floorLines, 0x17344a, [0, 0.03, z], [roomWidth - 0.1, 0.008, 0.018]);
    const stationCount = Math.min(3, Math.max(1, Math.ceil(zoneCenters.length / 2)));
    for (let i = 0; i < stationCount; i++) desk((i - (stationCount - 1) / 2) * 4.1, -roomDepth / 2 + 1.05);
    serverRack(stations, -roomWidth / 2 + 0.7, -roomDepth / 2 + 1.2);
    serverRack(stations, roomWidth / 2 - 0.7, -roomDepth / 2 + 1.2);
    // 侧边机柜与光带保留开放通道。
    box(stations, 0x0a0d15, [-roomWidth / 2 + 0.48, 0.47, -0.8], [0.64, 0.94, 2.7]);
    glowBox(stations, 0x8b5cf6, [-roomWidth / 2 + 0.48, 1.55, -0.8], [0.025, 1.25, 2.7]);
    for (const z of [-2.17, 0.57]) glowBox(stations, 0x28d7ff, [-roomWidth / 2 + 0.48, 1.55, z], [0.035, 1.3, 0.025]);
  }

  function animal(index: number) {
    const variant = index % 4;
    const accent = [0x28d7ff, 0xff4fd8, 0xffc857, 0x8b5cf6][variant]!;
    const accentSecondary = [0x6f8cff, 0x8b5cf6, 0xff7a59, 0x28d7ff][variant]!;
    const shell = [0x87b4cf, 0xd79ccc, 0xdab96a, 0xa99bd6][variant]!;
    const armor = [0x42698a, 0x774778, 0x806b3e, 0x5c4f86][variant]!;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const torso = box(body, shell, [0, 0.8, 0], [0.72, 0.76, 0.4]);
    box(body, armor, [0, 0.84, 0.24], [0.52, 0.48, 0.08]);
    box(body, 0x101722, [0, 0.84, 0.295], [0.34, 0.25, 0.025]);
    glowBox(body, accent, [0, 0.91, 0.292], [0.26, 0.055, 0.02]);
    glowBox(body, accentSecondary, [-0.16, 0.73, 0.292], [0.08, 0.08, 0.02]);
    box(body, armor, [0, 0.37, 0], [0.52, 0.18, 0.34]);
    for (const side of [-1, 1]) box(body, shell, [side * 0.47, 1.02, 0], [0.24, 0.17, 0.46]);
    const head = new THREE.Group();
    head.position.y = 1.53;
    body.add(head);
    box(head, shell, [0, 0, 0], [0.88, 0.7, 0.66]);
    box(head, armor, [0, 0.16, -0.03], [0.96, 0.24, 0.7]);
    box(head, 0x080b12, [0, -0.02, 0.35], [0.72, 0.27, 0.055]);
    const eyes: THREE.Mesh[] = [];
    for (const side of [-1, 1]) eyes.push(glowBox(head, accent, [side * 0.2, 0.01, 0.395], [0.12, 0.065, 0.025]));
    glowBox(head, accentSecondary, [0, -0.18, 0.38], [0.22, 0.035, 0.025]);
    const ears: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const antenna = new THREE.Group();
      antenna.position.set(side * 0.48, 0.22, -0.05);
      head.add(antenna);
      ears.push(antenna);
      box(antenna, shell, [0, 0.12, 0], [0.12, 0.32 + variant * 0.035, 0.12]);
      glowBox(antenna, side === -1 ? accent : accentSecondary, [0, 0.31 + variant * 0.035, 0], [0.11, 0.09, 0.11]);
    }
    const arms: THREE.Group[] = [];
    const feet: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.48, 1.04, 0);
      body.add(arm);
      box(arm, shell, [0, -0.2, 0], [0.2, 0.48, 0.22]);
      box(arm, armor, [0, -0.47, 0.02], [0.22, 0.18, 0.24]);
      glowBox(arm, side === -1 ? accentSecondary : accent, [0, -0.47, 0.15], [0.12, 0.055, 0.025]);
      arms.push(arm);
      feet.push(box(root, armor, [side * 0.23, 0.14, 0.08], [0.32, 0.28, 0.46]));
      glowBox(root, side === -1 ? accent : accentSecondary, [side * 0.23, 0.15, 0.32], [0.2, 0.04, 0.025]);
    }
    const tail = new THREE.Group();
    tail.position.set(0.33, 0.76, -0.27);
    body.add(tail);
    for (let i = 0; i < 4; i++)
      box(tail, i === 3 ? accent : 0x1a2230, [i * 0.09, -i * 0.13, -i * 0.12], [0.12, 0.18, 0.12]);
    const book = new THREE.Group();
    book.position.set(0, 0.9, 0.58);
    book.rotation.x = -0.15;
    body.add(book);
    box(book, 0x07131b, [0, 0, 0], [0.76, 0.48, 0.045]);
    glowBox(book, 0x28d7ff, [0, 0, 0.035], [0.68, 0.4, 0.018]);
    box(book, 0x102837, [0, 0, 0.058], [0.6, 0.32, 0.012]);
    for (let i = 0; i < 3; i++) glowBox(book, 0x28d7ff, [-0.08, 0.1 - i * 0.09, 0.07], [0.34, 0.015, 0.008]);
    const laptop = new THREE.Group();
    laptop.position.set(0, 0.69, 0.56);
    body.add(laptop);
    box(laptop, 0x0a0d15, [0, 0, 0], [0.82, 0.06, 0.48]);
    const lid = box(laptop, 0x0a0d15, [0, 0.23, 0.18], [0.82, 0.5, 0.055]);
    lid.rotation.x = -0.15;
    glowBox(laptop, accent, [0, 0.23, 0.222], [0.68, 0.36, 0.015]).rotation.x = -0.15;
    for (let i = 0; i < 4; i++)
      glowBox(laptop, i === 2 ? 0xff4fd8 : 0x28d7ff, [-0.18 + i * 0.12, 0.25 - i * 0.055, 0.24], [0.08, 0.018, 0.008]);
    const thought = new THREE.Group();
    thought.position.set(0.68, 1.85, 0);
    body.add(thought);
    for (let i = 0; i < 4; i++)
      glowBox(thought, i % 2 ? accentSecondary : accent, [i * 0.15, (i % 2) * 0.13, 0], [0.07, 0.07, 0.07]);
    const signal = new THREE.Group();
    signal.position.set(0.66, 1.55, 0);
    body.add(signal);
    for (let i = 0; i < 3; i++) glowBox(signal, accent, [i * 0.14, i * 0.13, 0], [0.05 + i * 0.025, 0.025, 0.025]);
    const statusLight = glowBox(root, accent, [0, 2.16, 0], [0.09, 0.09, 0.09]);
    book.visible = laptop.visible = thought.visible = signal.visible = false;
    return {
      root,
      body,
      torso,
      head,
      ears,
      arms,
      eyes,
      feet,
      tail,
      book,
      laptop,
      thought,
      signal,
      statusLight,
    };
  }
  type Actor = ReturnType<typeof animal> & {
    data: WorldAgent;
    zoneCenter: THREE.Vector3;
    phase: number;
    activitySince: number;
  };
  const actors = new Map<string, Actor>();
  let paused = false;
  let disposed = false;
  let visible = true;
  let frame = 0;
  let elapsed = 0;
  let previous = performance.now();
  let width = 1;
  let height = 1;
  let encounter: { from: string; to: string; start: number } | null = null;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = motion.matches;
  const onMotion = () => {
    reducedMotion = motion.matches;
  };
  motion.addEventListener('change', onMotion);
  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = bounds.width || 1;
    const nextHeight = bounds.height || 1;
    if (nextWidth !== width || nextHeight !== height) renderer.setSize(nextWidth, nextHeight, false);
    width = nextWidth;
    height = nextHeight;
    const aspect = width / height;
    camera.updateMatrixWorld();
    // 用控制舱边界计算取景，角色增多时扩展房间，避免裁掉边缘的角色和标签。
    const boundsInView = new THREE.Box3();
    for (const x of [-roomWidth / 2 - 0.4, roomWidth / 2 + 0.4])
      for (const z of [-roomDepth / 2 - 0.3, roomDepth / 2 + 0.6])
        for (const y of [0, 2.9])
          boundsInView.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
    const center = boundsInView.getCenter(new THREE.Vector3());
    const size = boundsInView.getSize(new THREE.Vector3());
    const halfHeight = Math.max(size.y / 2, size.x / (2 * aspect)) * 1.04;
    camera.left = center.x - halfHeight * aspect;
    camera.right = center.x + halfHeight * aspect;
    camera.top = center.y + halfHeight;
    camera.bottom = center.y - halfHeight;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  const raycaster = new THREE.Raycaster();
  function select(event: PointerEvent) {
    const bounds = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - bounds.left) / width) * 2 - 1,
        (-(event.clientY - bounds.top) / height) * 2 + 1,
      ),
      camera,
    );
    const hit = raycaster.intersectObjects(
      [...actors.values()].map((actor) => actor.root),
      true,
    )[0];
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object && !object.userData.agentId) object = object.parent;
    if (object) callbacks.select(object.userData.agentId);
  }
  canvas.addEventListener('pointerup', select);
  const project = (point: THREE.Vector3) => point.project(camera);
  function draw(now: number) {
    if (disposed) return;
    frame = requestAnimationFrame(draw);
    if (now - previous < 32) return;
    const dt = paused || !visible || document.hidden ? 0 : Math.min((now - previous) / 1000, 0.1);
    previous = now;
    if (!visible || document.hidden) return;
    elapsed += dt;
    const positions: AnimalPosition[] = [];
    const meetingAge = encounter ? elapsed - encounter.start : 0;
    if (encounter && meetingAge > 9) {
      encounter = null;
      callbacks.encounterEnd();
    }
    callbacks.encounterPhase(
      encounter ? (meetingAge < 2 ? 'approaching' : meetingAge < 7 ? 'talking' : 'returning') : null,
    );
    for (const actor of actors.values()) {
      const { root, body, head, arms, feet, data, zoneCenter } = actor;
      const time = reducedMotion ? 0 : elapsed + actor.phase;
      const activity = data.activity;
      const target = zoneCenter.clone();
      let facing = data.role === '协调与汇总' ? 0.06 : Math.atan2(-zoneCenter.x, 1 - zoneCenter.z);
      let talking = false;
      const currentEncounter = encounter;
      const involved = Boolean(
        currentEncounter && (data.id === currentEncounter.from || data.id === currentEncounter.to),
      );
      const partner =
        currentEncounter && involved
          ? actors.get(data.id === currentEncounter.from ? currentEncounter.to : currentEncounter.from)
          : undefined;
      if (currentEncounter && involved && partner && meetingAge < 7) {
        if (data.id === currentEncounter.from) {
          const direction = zoneCenter.clone().sub(partner.zoneCenter).setY(0).normalize();
          if (!direction.length()) direction.set(-1, 0, 0);
          target.copy(partner.zoneCenter).addScaledVector(direction, 1.55);
        }
        facing = Math.atan2(partner.root.position.x - root.position.x, partner.root.position.z - root.position.z);
        talking = meetingAge > 2;
      } else if (!involved) {
        const mobility =
          activity === 'thinking'
            ? 0.42
            : activity === 'idle' || activity === 'done'
              ? 0.32
              : activity === 'waiting'
                ? 0.2
                : 0.08;
        target.x += Math.sin(time * 0.31) * mobility;
        target.z += Math.sin(time * 0.23 + actor.phase * 0.7) * mobility * 0.72;
        if (activity === 'reading') {
          target.z += 0.12;
          facing -= 0.12;
        } else if (activity === 'command' || activity === 'writing') {
          target.z -= 0.12;
          facing += 0.14;
        }
      }
      const distance = root.position.distanceTo(target);
      const walking = distance > 0.07 && !reducedMotion;
      if (walking && !talking) facing = Math.atan2(target.x - root.position.x, target.z - root.position.z);
      root.position.lerp(target, reducedMotion ? 1 : Math.min(dt * 2, 1));
      const difference = Math.atan2(Math.sin(facing - root.rotation.y), Math.cos(facing - root.rotation.y));
      root.rotation.y += difference * (reducedMotion ? 1 : Math.min(dt * 5, 1));
      body.position.y = walking ? Math.abs(Math.sin(time * 9)) * 0.1 : Math.sin(time * 2) * 0.018;
      body.rotation.x = activity === 'command' ? 0.08 : activity === 'cancelled' ? -0.04 : 0;
      body.rotation.z = walking ? Math.sin(time * 9) * 0.06 : Math.sin(time * 1.5) * 0.012;
      head.rotation.set(
        activity === 'reading' ? 0.18 : activity === 'cancelled' ? 0.22 : Math.sin(time * 1.2) * 0.025,
        activity === 'failed' ? Math.sin(time * 5) * 0.16 : Math.sin(time * 0.8) * 0.06,
        activity === 'thinking' ? Math.sin(time * 1.4) * 0.08 - 0.08 : 0,
      );
      actor.tail.rotation.y = Math.sin(time * 2.5) * 0.16;
      actor.ears.forEach((ear, index) => {
        ear.rotation.z = Math.sin(time * 2 + index) * 0.025;
      });
      const blink = time % 4.7 > 4.52 ? 0.12 : 1;
      actor.eyes.forEach((eye) => {
        eye.scale.y = 0.065 * (reducedMotion ? 1 : blink);
      });
      feet.forEach((foot, index) => {
        foot.position.y = 0.14 + (walking ? Math.max(0, Math.sin(time * 9 + index * Math.PI)) * 0.2 : 0);
      });
      arms.forEach((arm, index) => {
        arm.rotation.set(walking ? Math.sin(time * 9 + index * Math.PI) * 0.45 : 0, 0, index ? -0.15 : 0.15);
        if (activity === 'reading') arm.rotation.x = -0.68;
        if (activity === 'writing' || activity === 'working')
          arm.rotation.x = -0.78 + Math.sin(time * 9 + index * Math.PI) * 0.13;
        if (activity === 'command') {
          arm.rotation.x = -0.9 + Math.sin(time * 15 + index * Math.PI) * 0.19;
          arm.rotation.z = index ? -0.26 : 0.26;
        }
        if (activity === 'thinking' && index === 1) {
          arm.rotation.z = -1.92;
          arm.rotation.x = -0.28;
        }
        if ((talking || activity === 'speaking' || activity === 'delegating') && index === 1)
          arm.rotation.z = -0.92 + Math.sin(time * 5) * 0.24;
        if (activity === 'done' && elapsed - actor.activitySince < 2 && !reducedMotion) {
          arm.rotation.z = index ? -2.05 : 2.05;
          body.position.y += Math.abs(Math.sin(time * 6)) * 0.13;
        }
      });
      actor.book.visible = !walking && !talking && activity === 'reading';
      actor.laptop.visible =
        !walking && !talking && (activity === 'writing' || activity === 'command' || activity === 'working');
      actor.laptop.position.y = 0.69 + (activity === 'command' ? Math.sin(time * 12) * 0.025 : 0);
      actor.thought.visible = !talking && activity === 'thinking';
      actor.thought.position.y = 1.85 + Math.sin(time * 2) * 0.06;
      actor.thought.rotation.y = time * 0.45;
      actor.signal.visible = !walking && (talking || activity === 'speaking' || activity === 'delegating');
      actor.signal.scale.setScalar(0.86 + Math.sin(time * 4) * 0.12);
      const statusPulse = ['thinking', 'reading', 'writing', 'command', 'delegating', 'working'].includes(activity)
        ? 0.07 + Math.abs(Math.sin(time * 4)) * 0.055
        : activity === 'waiting'
          ? 0.07 + Math.abs(Math.sin(time * 1.5)) * 0.035
          : 0.07;
      actor.statusLight.scale.set(statusPulse, statusPulse, statusPulse);
      actor.statusLight.visible = activity !== 'idle' && activity !== 'cancelled';
      const foot = project(root.position.clone().add(new THREE.Vector3(0, 0.12, 0.2)));
      const top = project(root.position.clone().add(new THREE.Vector3(0, 2.7, 0)));
      positions.push({ id: data.id, x: (foot.x + 1) * 50, y: (1 - foot.y) * 50, headY: (1 - top.y) * 50 });
    }
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    callbacks.positions(positions);
  }
  const lost = (event: Event) => {
    event.preventDefault();
    callbacks.unavailable();
  };
  canvas.addEventListener('webglcontextlost', lost);
  frame = requestAnimationFrame(draw);
  return {
    update(agents: WorldAgent[]) {
      const ids = new Set(agents.map((agent) => agent.id));
      const zoneCenters = agentZoneCenters(agents.length);
      for (const [id, actor] of actors)
        if (!ids.has(id)) {
          scene.remove(actor.root);
          actors.delete(id);
        }
      agents.forEach((data, index) => {
        let actor = actors.get(data.id);
        const zoneCenter = zoneCenters[index]!;
        if (!actor) {
          actor = { ...animal(index), data, zoneCenter, phase: index * 1.7, activitySince: elapsed - 3 };
          actor.root.position.copy(zoneCenter);
          actor.root.userData.agentId = data.id;
          actors.set(data.id, actor);
          scene.add(actor.root);
        }
        if (actor.data.activity !== data.activity) actor.activitySince = elapsed;
        actor.data = data;
        actor.zoneCenter = zoneCenter;
      });
      layoutRoom(zoneCenters);
      resize();
    },
    encounter(from: string, to: string) {
      encounter = { from, to, start: elapsed };
    },
    cancelEncounter() {
      encounter = null;
    },
    pause(value: boolean) {
      paused = value;
    },
    visibility(value: boolean) {
      visible = value;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerup', select);
      canvas.removeEventListener('webglcontextlost', lost);
      motion.removeEventListener('change', onMotion);
      cube.dispose();
      materials.forEach((entry) => entry.dispose());
      glowMaterials.forEach((entry) => entry.dispose());
      light.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
