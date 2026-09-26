import * as THREE from 'three';
import type { WorldAgent } from './agent-world';

export const animalNames = ['小熊猫', '垂耳兔', '薄荷熊', '小花猫'];
export const animalEmoji = ['🦊', '🐰', '🐻', '🐱'];
export interface AnimalPosition {
  id: string;
  x: number;
  y: number;
  headY: number;
}

/** 原生几何体组成的 3D 玩偶；动画只消费展示状态，不驱动任务执行。 */
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-6, 6, 4, -4, 0.1, 100);
  camera.position.set(3, 13, 17);
  camera.lookAt(0, 0.6, 0);
  scene.add(new THREE.HemisphereLight(0xf5f8ff, 0x7c889b, 2));
  const light = new THREE.DirectionalLight(0xfff0db, 2.6);
  light.position.set(-5, 10, 7);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  Object.assign(light.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
  light.shadow.normalBias = 0.04;
  light.shadow.bias = -0.0002;
  scene.add(light);
  const fill = new THREE.DirectionalLight(0xdbedff, 1.4);
  fill.position.set(6, 4, -6);
  scene.add(fill);

  const sphere = new THREE.SphereGeometry(1, 24, 18);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 48);
  const cone = new THREE.ConeGeometry(1, 1, 24);
  const ring = new THREE.TorusGeometry(0.72, 0.025, 8, 48);
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const material = (color: number) => {
    if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.78 }));
    return materials.get(color)!;
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
  const ball = (parent: THREE.Object3D, color: number, position: number[], scale: number[]) =>
    shape(parent, sphere, color, position, scale);
  const box = (parent: THREE.Object3D, color: number, position: number[], scale: number[]) =>
    shape(parent, cube, color, position, scale);
  const environment = new THREE.Group();
  scene.add(environment);
  // 中性石材地面、开放通道和后排工位；角色继续使用独立的卡通造型。
  const platform = box(environment, 0x8e9bab, [0, -0.23, 0], [16, 0.4, 10]);
  const floor = box(environment, 0xe3e7ed, [0, -0.015, 0], [15.9, 0.08, 9.9]);
  const architecture = new THREE.Group();
  const floorLines = new THREE.Group();
  const stations = new THREE.Group();
  environment.add(architecture, floorLines, stations);
  const rearWall = box(architecture, 0xc9d2df, [0, 1.15, 0], [16, 2.3, 0.15]);
  const wallCap = box(architecture, 0x657489, [0, 2.32, 0], [16, 0.045, 0.2]);
  const wallTrim = box(architecture, 0x7c8fa7, [0, 0.12, 0.1], [16, 0.08, 0.08]);
  const lightStrip = box(architecture, 0xf5faff, [0, 2.12, 0.1], [15, 0.035, 0.025]);
  // 墙上的共享看板，使用几何图形，不模拟额外运行状态。
  box(architecture, 0x33445a, [0, 1.37, 0.13], [3.4, 1.13, 0.08]);
  box(architecture, 0xd7e2ee, [-0.95, 1.68, 0.18], [0.9, 0.04, 0.02]);
  for (let i = 0; i < 3; i++) {
    box(architecture, 0x7d9dbe, [-0.94, 1.43 - i * 0.19, 0.18], [0.09, 0.09, 0.02]);
    box(architecture, 0xadbdd0, [-0.42, 1.43 - i * 0.19, 0.18], [0.72, 0.04, 0.02]);
    box(architecture, 0x6f92b5, [0.54 + i * 0.32, 1.17 + i * 0.08, 0.18], [0.18, 0.28 + i * 0.16, 0.02]);
  }
  function plant(parent: THREE.Object3D, x: number, z: number) {
    const planter = new THREE.Group();
    planter.position.set(x, 0, z);
    parent.add(planter);
    box(planter, 0x728297, [0, 0.32, 0], [0.65, 0.64, 0.65]);
    for (let i = 0; i < 6; i++) {
      const angle = i * 2.4;
      const leaf = ball(
        planter,
        i % 2 ? 0x647d70 : 0x81978a,
        [Math.sin(angle) * 0.18, 0.95 + i * 0.09, Math.cos(angle) * 0.2],
        [0.12, 0.48, 0.09],
      );
      leaf.rotation.set(Math.cos(angle) * 0.35, angle, Math.sin(angle) * 0.45);
    }
  }
  function desk(x: number, z: number) {
    const desk = new THREE.Group();
    desk.position.set(x, 0, z);
    stations.add(desk);
    box(desk, 0xb5a491, [0, 0.98, 0], [2.5, 0.1, 0.95]);
    for (const side of [-1, 1]) box(desk, 0x637086, [side * 1.05, 0.47, 0], [0.07, 0.95, 0.72]);
    box(desk, 0x4b5e76, [0, 1.42, -0.15], [1.08, 0.67, 0.09]);
    box(desk, 0xb7cde1, [0, 1.42, -0.095], [0.94, 0.53, 0.012]);
    box(desk, 0x758fac, [-0.18, 1.52, -0.085], [0.38, 0.035, 0.008]);
    box(desk, 0x91acc5, [-0.05, 1.4, -0.085], [0.63, 0.025, 0.008]);
    box(desk, 0x576b85, [0, 1.09, -0.15], [0.11, 0.21, 0.11]);
    box(desk, 0x8797aa, [0, 1.05, 0.23], [0.7, 0.03, 0.23]);
    box(desk, 0x8292a4, [0.95, 0.47, -0.01], [0.42, 0.87, 0.65]);
  }
  let roomWidth = 16;
  let roomDepth = 10;
  let layoutKey = '';
  function layoutRoom(columns: number, rows: number) {
    const key = `${columns}:${rows}`;
    if (key === layoutKey) return;
    layoutKey = key;
    roomWidth = Math.max(10.4, (columns - 1) * 4.4 + 7.2);
    roomDepth = (rows - 1) * 5.2 + 9.6;
    platform.scale.set(roomWidth, 0.4, roomDepth);
    floor.scale.set(roomWidth - 0.08, 0.08, roomDepth - 0.08);
    architecture.position.z = -roomDepth / 2 + 0.15;
    rearWall.scale.x = wallCap.scale.x = wallTrim.scale.x = roomWidth;
    lightStrip.scale.x = roomWidth - 1;
    // 复用几何与材质，仅在工位行列变化时重排场景。
    floorLines.clear();
    stations.clear();
    for (let x = -roomWidth / 2 + 2.2; x < roomWidth / 2; x += 2.2)
      box(floorLines, 0xcdd5df, [x, 0.03, 0], [0.018, 0.008, roomDepth - 0.1]);
    for (let z = -roomDepth / 2 + 2.2; z < roomDepth / 2; z += 2.2)
      box(floorLines, 0xcdd5df, [0, 0.03, z], [roomWidth - 0.1, 0.008, 0.018]);
    const stationCount = Math.max(2, columns);
    for (let i = 0; i < stationCount; i++) desk((i - (stationCount - 1) / 2) * 3.8, -roomDepth / 2 + 1.15);
    plant(stations, -roomWidth / 2 + 0.7, -roomDepth / 2 + 1.2);
    plant(stations, roomWidth / 2 - 0.7, -roomDepth / 2 + 1.2);
    // 侧边低柜和玻璃隔断框线，保持前方通道开敞。
    box(stations, 0x9baabd, [-roomWidth / 2 + 0.48, 0.47, -0.8], [0.64, 0.94, 2.7]);
    box(stations, 0xc0cfde, [-roomWidth / 2 + 0.48, 1.55, -0.8], [0.045, 1.25, 2.7]);
    for (const z of [-2.17, 0.57]) box(stations, 0x72859d, [-roomWidth / 2 + 0.48, 1.55, z], [0.055, 1.3, 0.045]);
  }

  function animal(index: number) {
    const variant = index % 4;
    const color = [0xd78b56, 0xf0dfcb, 0x94b7a5, 0xb6a4c7][variant]!;
    const pale = variant === 1 ? 0xfff4e8 : 0xf8e8d1;
    const dark = variant === 0 ? 0x674d42 : 0x706659;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const torso = ball(body, color, [0, 0.75, 0], [0.48, 0.56, 0.37]);
    ball(body, pale, [0, 0.77, 0.29], [0.31, 0.37, 0.1]);
    const head = new THREE.Group();
    head.position.y = 1.5;
    body.add(head);
    ball(head, color, [0, 0, 0], [0.65, 0.56, 0.48]);
    const ears: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(side * 0.43, 0.37, -0.02);
      head.add(ear);
      ears.push(ear);
      if (variant === 1) {
        ball(ear, color, [0, 0.35, 0], [0.17, 0.53, 0.15]);
        ball(ear, 0xe7b6ae, [0, 0.35, 0.12], [0.095, 0.37, 0.035]);
        ear.rotation.z = side * -0.14;
      } else if (variant === 3 || variant === 0) {
        const outer = shape(ear, cone, color, [0, 0.1, 0], [0.25, 0.4, 0.2]);
        outer.rotation.z = side * -0.22;
        const inner = shape(ear, cone, variant === 0 ? pale : 0xe7b4b2, [0, 0.12, 0.11], [0.14, 0.24, 0.05]);
        inner.rotation.z = side * -0.22;
      } else {
        ball(ear, color, [0, 0.08, 0], [0.24, 0.25, 0.16]);
        ball(ear, pale, [0, 0.08, 0.13], [0.13, 0.14, 0.04]);
      }
      if (variant === 0) {
        const patch = ball(head, pale, [side * 0.33, -0.02, 0.38], [0.24, 0.24, 0.12]);
        patch.rotation.z = side * -0.4;
        ball(head, pale, [side * 0.25, 0.23, 0.41], [0.11, 0.045, 0.035]);
      }
      ball(head, 0xe7afa6, [side * 0.4, -0.16, 0.4], [0.13, 0.065, 0.035]);
    }
    const eyes: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      eyes.push(ball(head, 0x343c35, [side * 0.23, 0.02, 0.447], [0.068, 0.094, 0.034]));
      ball(head, 0xffffff, [side * 0.23 - 0.017, 0.058, 0.477], [0.019, 0.023, 0.01]);
    }
    ball(head, pale, [0, -0.17, 0.44], [0.2, 0.14, 0.09]);
    ball(head, variant === 1 ? 0xbd8c86 : dark, [0, -0.1, 0.537], [0.067, 0.044, 0.03]);
    for (const side of [-1, 1]) {
      const mouth = ball(head, dark, [side * 0.04, -0.22, 0.531], [0.046, 0.013, 0.008]);
      mouth.rotation.z = side * 0.2;
    }
    // 软围巾及扣子。
    ball(body, [0x728f86, 0xc7978c, 0xdaae77, 0x869ba8][variant]!, [0, 1.08, 0.07], [0.39, 0.12, 0.34]);
    box(body, [0x728f86, 0xc7978c, 0xdaae77, 0x869ba8][variant]!, [0.18, 0.9, 0.34], [0.14, 0.35, 0.045]);
    const arms: THREE.Group[] = [];
    const feet: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.43, 0.97, 0);
      body.add(arm);
      ball(arm, color, [0, -0.2, 0], [0.15, 0.29, 0.15]);
      ball(arm, variant === 0 ? dark : pale, [0, -0.4, 0.025], [0.145, 0.14, 0.15]);
      arms.push(arm);
      feet.push(ball(root, variant === 0 ? dark : color, [side * 0.25, 0.2, 0.07], [0.22, 0.21, 0.29]));
    }
    const tail = new THREE.Group();
    tail.position.set(0, 0.6, -0.32);
    body.add(tail);
    if (variant === 0 || variant === 3) {
      for (let i = 0; i < 5; i++)
        ball(
          tail,
          variant === 0 ? (i % 2 ? pale : color) : color,
          [0.09 * i, 0.09 * i, -0.14 - i * 0.14],
          [0.24 - i * 0.026, 0.22 - i * 0.016, 0.2],
        );
    } else ball(tail, pale, [0, 0, -0.07], [0.21, 0.2, 0.2]);
    const book = new THREE.Group();
    book.position.set(0, 0.81, 0.49);
    book.rotation.x = -0.35;
    body.add(book);
    box(book, 0x789a8a, [0, 0, 0], [0.7, 0.43, 0.06]);
    for (const side of [-1, 1]) {
      const page = box(book, 0xfff3d7, [side * 0.16, 0.01, 0.05], [0.31, 0.38, 0.055]);
      page.rotation.y = side * -0.13;
      for (let i = 0; i < 3; i++) box(page, 0xbbc7ac, [0, 0.08 - i * 0.09, 0.55], [0.65, 0.03, 0.02]);
    }
    const laptop = new THREE.Group();
    laptop.position.set(0, 0.66, 0.58);
    body.add(laptop);
    box(laptop, 0x829e98, [0, 0, 0], [0.75, 0.06, 0.47]);
    const lid = box(laptop, 0x658783, [0, 0.21, 0.18], [0.75, 0.47, 0.055]);
    lid.rotation.x = -0.15;
    ball(laptop, 0xebd2a4, [0, 0.23, 0.22], [0.07, 0.07, 0.015]);
    const thought = new THREE.Group();
    thought.position.set(0.6, 1.95, 0);
    body.add(thought);
    for (let i = 0; i < 3; i++)
      ball(thought, 0xffedbb, [i * 0.16, i * 0.1, 0], [0.065 + i * 0.01, 0.065 + i * 0.01, 0.065]);
    const halo = shape(root, ring, 0xd7ae74, [0, 0.06, 0], [1, 1, 1]);
    halo.rotation.x = -Math.PI / 2;
    book.visible = laptop.visible = thought.visible = false;
    return { root, body, torso, head, ears, arms, eyes, feet, tail, book, laptop, thought, halo };
  }
  type Actor = ReturnType<typeof animal> & {
    data: WorldAgent;
    home: THREE.Vector3;
    phase: number;
    activitySince: number;
  };
  const actors = new Map<string, Actor>();
  let selected = '';
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
    // 用办公室边界计算取景，角色增多时扩展房间，避免裁掉边缘的角色和标签。
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
      const { root, body, head, arms, feet, data, home } = actor;
      const time = reducedMotion ? 0 : elapsed + actor.phase;
      const activity = data.activity;
      const target = home.clone();
      let facing = 0.12;
      let talking = false;
      const partner = encounter ? actors.get(data.id === encounter.from ? encounter.to : encounter.from) : undefined;
      if (encounter && partner && (data.id === encounter.from || data.id === encounter.to) && meetingAge < 7) {
        if (data.id === encounter.from) {
          const direction = home.clone().sub(partner.home).setY(0).normalize();
          if (!direction.length()) direction.set(-1, 0, 0);
          target.copy(partner.home).addScaledVector(direction, 1.55);
        }
        facing = Math.atan2(partner.root.position.x - root.position.x, partner.root.position.z - root.position.z);
        talking = meetingAge > 2;
      } else if (activity === 'reading') {
        target.z += 0.12;
        facing = -0.2;
      } else if (activity === 'command' || activity === 'writing') {
        target.z -= 0.12;
        facing = 0.2;
      }
      const distance = root.position.distanceTo(target);
      const walking = distance > 0.07 && !reducedMotion;
      root.position.lerp(target, reducedMotion ? 1 : Math.min(dt * 2, 1));
      const difference = Math.atan2(Math.sin(facing - root.rotation.y), Math.cos(facing - root.rotation.y));
      root.rotation.y += difference * (reducedMotion ? 1 : Math.min(dt * 5, 1));
      body.position.y = walking ? Math.abs(Math.sin(time * 9)) * 0.1 : Math.sin(time * 2) * 0.025;
      body.rotation.z = walking ? Math.sin(time * 9) * 0.06 : Math.sin(time * 1.5) * 0.018;
      head.rotation.set(
        activity === 'reading' ? 0.15 : Math.sin(time * 1.2) * 0.035,
        Math.sin(time * 0.8) * 0.1,
        activity === 'thinking' ? Math.sin(time * 1.4) * 0.1 - 0.1 : 0,
      );
      actor.tail.rotation.y = Math.sin(time * 2.5) * 0.3;
      actor.ears.forEach((ear, index) => {
        ear.rotation.x = Math.sin(time * 2 + index) * 0.05;
      });
      const blink = time % 4.7 > 4.52 ? 0.12 : 1;
      actor.eyes.forEach((eye) => {
        eye.scale.y = 0.094 * (reducedMotion ? 1 : blink);
      });
      feet.forEach((foot, index) => {
        foot.position.y = 0.2 + (walking ? Math.max(0, Math.sin(time * 9 + index * Math.PI)) * 0.2 : 0);
      });
      arms.forEach((arm, index) => {
        arm.rotation.set(walking ? Math.sin(time * 9 + index * Math.PI) * 0.45 : 0, 0, index ? -0.15 : 0.15);
        if (activity === 'reading') arm.rotation.x = -0.75;
        if (activity === 'writing' || activity === 'command')
          arm.rotation.x = -0.8 + Math.sin(time * 10 + index * Math.PI) * 0.14;
        if (activity === 'thinking' && index === 1) {
          arm.rotation.z = -2.1;
          arm.rotation.x = -0.3;
        }
        if ((talking || activity === 'speaking' || activity === 'delegating') && index === 1)
          arm.rotation.z = -0.8 + Math.sin(time * 5) * 0.2;
        if (activity === 'done' && elapsed - actor.activitySince < 2 && !reducedMotion) {
          arm.rotation.z = index ? -2.3 : 2.3;
          body.position.y += Math.abs(Math.sin(time * 6)) * 0.13;
        }
      });
      actor.book.visible = !walking && !talking && activity === 'reading';
      actor.laptop.visible = !walking && !talking && (activity === 'writing' || activity === 'command');
      actor.thought.visible = !talking && activity === 'thinking';
      actor.thought.position.y = 1.95 + Math.sin(time * 2) * 0.06;
      actor.halo.visible = selected === data.id;
      if (activity === 'failed') head.rotation.z = Math.sin(time * 4) * 0.1;
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
    update(agents: WorldAgent[], selectedId: string) {
      selected = selectedId;
      const ids = new Set(agents.map((agent) => agent.id));
      for (const [id, actor] of actors)
        if (!ids.has(id)) {
          scene.remove(actor.root);
          actors.delete(id);
        }
      agents.forEach((data, index) => {
        let actor = actors.get(data.id);
        const columns = Math.min(agents.length > 6 ? 4 : 3, agents.length);
        const row = Math.floor(index / columns);
        const rowSize = Math.min(columns, agents.length - row * columns);
        const home = new THREE.Vector3(
          ((index % columns) - (rowSize - 1) / 2) * 4.4,
          0,
          row * 5.2 - (Math.ceil(agents.length / columns) - 1) * 2.6 + 0.8,
        );
        if (!actor) {
          actor = { ...animal(index), data, home, phase: index * 1.7, activitySince: elapsed - 3 };
          actor.root.position.copy(home);
          actor.root.userData.agentId = data.id;
          actors.set(data.id, actor);
          scene.add(actor.root);
        }
        if (actor.data.activity !== data.activity) actor.activitySince = elapsed;
        actor.data = data;
        actor.home = home;
      });
      const columns = Math.min(agents.length > 6 ? 4 : 3, Math.max(1, agents.length));
      layoutRoom(columns, Math.ceil(agents.length / columns));
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
      [sphere, cube, cylinder, cone, ring].forEach((geometry) => geometry.dispose());
      materials.forEach((entry) => entry.dispose());
      light.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
