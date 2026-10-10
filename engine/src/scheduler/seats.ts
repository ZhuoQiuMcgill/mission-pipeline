// Dispatching seat units (design 6.2, 6.5, 7.1, 9.3; WI-10, WI-18): what the scheduler decides
// for a seat before its unit starts, with the execution layer's own rules.
//
//  - The startup self-check gate (9.3): no passing record for the toolchain in use, no seat is
//    started (WI-18); work that needs no seat goes on. Item 9 alone decides whether a money
//    spend_limit may be set (6.5).
//  - The unit's demand (exec/resources.ts UnitDemand, with the recovery state when the card
//    allows async evidence, and its restore when the seat resumes from it) gives the
//    reservations: memory (the unit's memory.max), disk and inodes.
//  - The writable area is decided at admission (planUnitArea): a capped tmpfs; a fixed-size
//    image, created and fully allocated now, mounted by the host with fuse2fs and released as
//    cleanup resources; or a resource block (no fuse2fs: WI-10, no other degradation path).
//  - The unit itself: the seat host's config file and the supervisor's config
//    (seat/unit.ts seatUnitConfig, with the content root so the host's temporary export object
//    is a cleanup resource).

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import { contentHash, type ContentHash, type Generation, type LaunchId } from '../common/ids.ts';
import { seatCardEntry } from '../seat/cards/index.ts';
import { needsSandbox } from '../seat/profiles.ts';
import { formatCleanupResource, recordIdentities } from '../exec/cleanup.ts';
import type { ContentStore } from '../ledger/content.ts';
import { writePrepared } from './localState.ts';
import type { RetryPolicy } from '../exec/proof.ts';
import { detectAreaTools, planUnitArea, unitDiskReservation, unitInodeReservation, unitMemoryReservation, type AreaPlan, type AreaTools, type StoreGeometry, type UnitDemand } from '../exec/resources.ts';
import { createDiskImage, probePrivateImageMount } from '../exec/sandbox.ts';
import { seatGatePolicy, selfCheckGate, toolchainVersions, type GateVerdict } from '../exec/selfcheck.ts';
import type { LaunchSupervisorOptions, SinkModuleRef, SupervisorConfig } from '../exec/supervisor.ts';
import type { HostArea, SeatHostConfig } from '../seat/host.ts';
import { seatUnitConfig } from '../seat/unit.ts';
import type { Demand } from './tasks.ts';

/** What the installation gives every seat (9.3, 9.6). */
export interface SeatInstall {
  /** The startup self-check evidence (9.3): no passing record, no seat. */
  readonly selfCheckDir: string;
  /** Tests only: accept items recorded as fixtures. Production never sets it. */
  readonly acceptFixtures?: boolean;
  readonly credentials: SeatHostConfig['credentials'];
  readonly modelConfig?: string;
  readonly upstream?: string;
  readonly environment?: SeatHostConfig['environment'];
  readonly install?: SeatHostConfig['install'];
  readonly enclosure?: SeatHostConfig['enclosure'];
  readonly heartbeatMs?: number;
  readonly claudeExecutable?: string;
  /** A configured fuse2fs (large-disk areas, 7.1). */
  readonly fuse2fs?: string;
  /**
   * The install-time result of probePrivateImageMount (exec/sandbox.ts): fuse2fs mounts inside a
   * private user namespace, as units do (v49 7.1). Unset: the scheduler probes once, at the first
   * large-disk admission. False: large-disk units are resource-blocked (WI-10).
   */
  readonly privateFuseMount?: boolean;
  /** The content store's geometry, measured at install (6.5). */
  readonly geometry?: StoreGeometry;
  /** The seat host's environment (a transient service inherits nothing). */
  readonly hostEnv?: Readonly<Record<string, string>>;
  readonly pidsMax?: number;
}

/** A task whose unit is a seat (its card is in the content store). */
export interface SeatTaskSpec {
  /**
   * The card's hash in the content store: the template every attempt is stamped from (each
   * launch gets its own card, naming its launch id, which the seat host checks).
   */
  readonly card: string;
  /** What the unit needs over its whole life (exec/resources.ts). */
  readonly demand: UnitDemand;
  /** 6.2: a continuation after async evidence (the card's `resume`), set by resumeAfterEvidence. */
  readonly resume?: SeatResume;
}

/** The card's `resume` (seat/card.ts): the session to continue, its saved state, the evidence results. */
export interface SeatResume {
  readonly sessionId: string;
  readonly state: string | null;
  readonly evidence: string;
}

/**
 * The card of one launch: the task's card with this launch's id (and the resume, for a
 * continuation), stored in the content store. A card that is not a seat card is refused.
 */
export function stampCard(content: ContentStore, template: string, launch: LaunchId, resume?: SeatResume): ContentHash {
  const card = JSON.parse(content.get(contentHash(template)).toString('utf8')) as Record<string, unknown>;
  if (card['format'] !== 'mp4.seat-card.v1') throw new Error(`content ${template} is not a seat card (format ${String(card['format'])})`);
  return content.put(JSON.stringify({ ...card, launch, ...(resume !== undefined ? { resume } : {}) }));
}

/** The kind of a seat card (its `seat` field, src/seat/cards registry). */
export function seatCardKind(content: ContentStore, template: string): string {
  const card = JSON.parse(content.get(contentHash(template)).toString('utf8')) as Record<string, unknown>;
  if (card['format'] !== 'mp4.seat-card.v1' || typeof card['seat'] !== 'string') throw new Error(`content ${template} is not a seat card`);
  seatCardEntry(card['seat']); // an unknown kind throws
  return card['seat'];
}

/**
 * Whether a card kind's seat runs file tools in a sandbox, so its unit gets a writable area (a
 * tmpfs or an image, 7.1). A 'materials' seat reads only its materials: no area, no image.
 */
export function seatNeedsArea(kind: string): boolean {
  return needsSandbox(seatCardEntry(kind).toolProfile);
}

/** The seat host's outcome file (seat/host.ts outcomePath; read without loading the host). */
export function readSeatOutcome(stateDir: string, launch: LaunchId): { sessionId: string | null } | null {
  try {
    const o = JSON.parse(readFileSync(join(stateDir, 'units', launch, 'outcome.json'), 'utf8')) as { format?: string; sessionId?: string | null };
    return o.format === 'mp4.seat-host-outcome.v1' ? { sessionId: o.sessionId ?? null } : null;
  } catch {
    return null;
  }
}

const DEFAULT_GEOMETRY: StoreGeometry = { blockBytes: 4096 };

/** seat/host.ts SEAT_HOST_CONFIG_FORMAT (not imported: loading host.ts loads the Agent SDK). */
const SEAT_HOST_CONFIG_FORMAT_V1 = 'mp4.seat-host.v1' as SeatHostConfig['format'];

/** 9.3: may seats start, and may a money spend_limit be set, with the toolchain in use. */
export function seatGate(install: SeatInstall): GateVerdict {
  const versions = toolchainVersions(install.claudeExecutable !== undefined ? { claudeExecutable: install.claudeExecutable } : {});
  return selfCheckGate(install.selfCheckDir, versions, seatGatePolicy(install));
}

/** 6.5: the seat unit's reservations over its whole life (recovery state included). */
export function seatReservation(d: UnitDemand, geometry: StoreGeometry = DEFAULT_GEOMETRY): Demand {
  return { memoryBytes: unitMemoryReservation(d), diskBytes: unitDiskReservation(d, geometry), inodes: unitInodeReservation(d) };
}

/**
 * The area tools of this machine (9.6), with the private-namespace mount probe: from the install
 * record when it has it, else probed once (the result is cached by the caller).
 */
export async function seatAreaTools(install: SeatInstall): Promise<AreaTools> {
  const tools = detectAreaTools(install.fuse2fs);
  if (install.privateFuseMount !== undefined) return { ...tools, privateFuseMount: install.privateFuseMount };
  if (tools.fuse2fs === null) return tools;
  const bwrap = install.install?.bwrap;
  const nsenter = install.install?.nsenter;
  const probe = await probePrivateImageMount(tools.fuse2fs, { ...(bwrap !== undefined ? { bwrap } : {}), ...(nsenter !== undefined ? { nsenter } : {}) });
  return { ...tools, privateFuseMount: probe.ok };
}

/** 7.1: the writable area admission decides (the host honours it, never picks one). */
export function seatAreaPlan(d: UnitDemand, tools: AreaTools): AreaPlan {
  return planUnitArea(d, tools);
}

export interface PreparedSeat {
  readonly config: LaunchSupervisorOptions['config'];
  readonly hostConfigPath: string;
  readonly image: { readonly path: string; readonly mountDir: string } | null;
}

/**
 * Admission's side effects for one seat launch: the image (created and fully allocated now,
 * 7.1 step 1), the host config, the supervisor config with the image and its mount as cleanup
 * resources.
 */
export async function prepareSeatLaunch(o: {
  readonly launch: LaunchId;
  readonly stateDir: string;
  readonly controlPlane: string;
  readonly ledgerSocket: string;
  readonly contentRoot: string;
  /** This launch's card (stampCard). */
  readonly card: ContentHash;
  /** What the preparation holds, recorded with it (r1 #11). */
  readonly reservation: Demand;
  /** The scheduler generation dispatching it: the ledger authorizes a read-web seat's fetches with it (6.1). */
  readonly generation: Generation;
  readonly install: SeatInstall;
  readonly seat: SeatTaskSpec;
  /** null: a 'materials' seat (no sandbox, no writable area). */
  readonly plan: Exclude<AreaPlan, { kind: 'resource-blocked' }> | null;
  readonly sink: SinkModuleRef;
  readonly stopScope: SupervisorConfig['stopScope'];
  readonly nodePath?: string;
  readonly retry?: Partial<RetryPolicy>;
}): Promise<PreparedSeat> {
  const seats = join(o.stateDir, 'seats');
  const dir = join(seats, o.launch);
  mkdirSync(seats, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  // recorded before anything big is created, bound to the identities as they are created, so a
  // crash or a refusal before registration still has a cleanup path (r1 #11; exec cleanup
  // deletes only identity-bound entries)
  const policy = { roots: [seats] };
  const dirRes = recordIdentities([formatCleanupResource({ kind: 'path', path: dir })], policy);
  const record = (resources: readonly string[]): void => writePrepared(o.stateDir, { format: 'mp4.prepared-launch.v1', launch: o.launch, resources, demand: o.reservation, at: Date.now() });
  record(dirRes);
  let area: HostArea = { kind: 'tmpfs' };
  let image: PreparedSeat['image'] = null;
  if (o.plan !== null && o.plan.kind === 'image') {
    const path = join(dir, 'area.img');
    const mountDir = join(dir, 'area.mnt');
    mkdirSync(mountDir, { mode: 0o700 });
    await createDiskImage({ path, bytes: o.plan.bytes, inodes: o.plan.inodes });
    record([formatCleanupResource({ kind: 'mount', path: mountDir }), ...recordIdentities([formatCleanupResource({ kind: 'image', path })], policy), ...dirRes]);
    area = { kind: 'image', image: path, mountDir };
    image = { path, mountDir };
  }
  const i = o.install;
  const host: SeatHostConfig = {
    format: SEAT_HOST_CONFIG_FORMAT_V1,
    card: o.card,
    generation: o.generation,
    contentRoot: o.contentRoot,
    ledgerSocket: o.ledgerSocket,
    controlPlane: o.controlPlane,
    stateDir: o.stateDir,
    sessionDir: join(dir, 'session'),
    area,
    selfCheck: { dir: i.selfCheckDir, ...(i.acceptFixtures === true ? { acceptFixtures: true } : {}) },
    credentials: i.credentials,
    ...(i.modelConfig !== undefined ? { modelConfig: i.modelConfig } : {}),
    ...(i.upstream !== undefined ? { upstream: i.upstream } : {}),
    ...(i.environment !== undefined ? { environment: i.environment } : {}),
    // the fuse2fs admission planned the image with goes to the host too (e2e B3)
    ...(i.install !== undefined || i.fuse2fs !== undefined ? { install: { ...(i.install ?? {}), ...(i.fuse2fs !== undefined ? { fuse2fs: i.fuse2fs } : {}) } } : {}),
    ...(i.enclosure !== undefined ? { enclosure: i.enclosure } : {}),
    ...(i.heartbeatMs !== undefined ? { heartbeatMs: i.heartbeatMs } : {}),
    ...(i.claudeExecutable !== undefined ? { claudeExecutable: i.claudeExecutable } : {}),
  };
  const hostConfigPath = join(dir, 'host.json');
  writeFileAtomic(hostConfigPath, `${JSON.stringify(host, null, 2)}\n`);
  const config = seatUnitConfig({
    launch: o.launch,
    stateDir: o.stateDir,
    hostConfigPath,
    unit: { memoryMax: unitMemoryReservation(o.seat.demand), pidsMax: i.pidsMax ?? 256 },
    sink: o.sink,
    env: i.hostEnv ?? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    cwd: dir,
    ...(o.nodePath !== undefined ? { nodePath: o.nodePath } : {}),
    // outside the seat directory, which is deleted with the unit
    stdoutPath: join(o.stateDir, 'logs', `${o.launch}.host.out`),
    stderrPath: join(o.stateDir, 'logs', `${o.launch}.host.err`),
    ...(o.retry !== undefined ? { retry: o.retry } : {}),
    ...(o.stopScope !== undefined ? { stopScope: o.stopScope } : {}),
    // the seat directory is a scratch directory of the unit: bound to its identity when the unit
    // starts and deleted at its end (after the image and its mount)
    cleanup: { ...(image !== null ? { fuseMounts: [image.mountDir], images: [image.path] } : {}), scratchDirs: [dir] },
    contentRoot: o.contentRoot,
  });
  return { config, hostConfigPath, image };
}
