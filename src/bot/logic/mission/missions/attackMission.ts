import {
    ActionsApi,
    GameApi,
    ObjectType,
    PlayerData,
    ProductionApi,
    SideType,
    UnitData,
    Vector2,
} from "@chronodivide/game-api";
import { CombatSquad } from "./squads/combatSquad.js";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import { RetreatMission } from "./retreatMission.js";
import { DebugLogger, countBy, isOwnedByNeutral, maxBy } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { getSovietComposition } from "../../composition/sovietCompositions.js";
import { getAlliedCompositions } from "../../composition/alliedCompositions.js";
import { UnitComposition } from "../../composition/common.js";
import { manageMoveMicro } from "./squads/common.js";

export enum AttackFailReason {
    NoTargets = 0,
    DefenceTooStrong = 1,
}

enum AttackMissionState {
    Preparing = 0,
    Attacking = 1,
    Retreating = 2,
}

const NO_TARGET_RETARGET_TICKS = 450;
const NO_TARGET_IDLE_TIMEOUT_TICKS = 900;

function calculateTargetComposition(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition {
    if (!playerData.country) {
        throw new Error(`player ${playerData.name} has no country`);
    } else if (playerData.country.side === SideType.Nod) {
        return getSovietComposition(gameApi, playerData, matchAwareness);
    } else {
        return getAlliedCompositions(gameApi, playerData, matchAwareness);
    }
}

const ATTACK_MISSION_PRIORITY_RAMP = 1.01;
const ATTACK_MISSION_MAX_PRIORITY = 50;

/**
 * A mission that tries to attack a certain area.
 */
export class AttackMission extends Mission<AttackFailReason> {
    private squad: CombatSquad;

    private lastTargetSeenAt = 0;
    private hasPickedNewTarget: boolean = false;

    private state: AttackMissionState = AttackMissionState.Preparing;

    constructor(
        uniqueName: string,
        private priority: number,
        rallyArea: Vector2,
        private attackArea: Vector2,
        private radius: number,
        logger: DebugLogger,
        private composition: UnitComposition,
        private dissolveUnfulfilledAt: number | null = null,
    ) {
        super(uniqueName, logger);
        this.squad = new CombatSquad(attackArea);
    }

    _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        switch (this.state) {
            case AttackMissionState.Preparing:
                return this.handlePreparingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
            case AttackMissionState.Attacking:
                return this.handleAttackingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
            case AttackMissionState.Retreating:
                return this.handleRetreatingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
        }
    }

    private handlePreparingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        const currentComposition: UnitComposition = countBy(this.getUnitsGameObjectData(gameApi), (unit) => unit.name);

        const missingUnits = Object.entries(this.composition).filter(([unitType, targetAmount]) => {
            return !currentComposition[unitType] || currentComposition[unitType] < targetAmount;
        });

        if (this.dissolveUnfulfilledAt && gameApi.getCurrentTick() > this.dissolveUnfulfilledAt) {
            return disbandMission();
        }

        if (missingUnits.length > 0) {
            this.priority = Math.min(this.priority * ATTACK_MISSION_PRIORITY_RAMP, ATTACK_MISSION_MAX_PRIORITY);
            return requestUnits(
                missingUnits.map(([unitName]) => unitName),
                this.priority,
            );
        } else {
            this.priority = ATTACK_MISSION_INITIAL_PRIORITY;
            this.state = AttackMissionState.Attacking;
            return noop();
        }
    }

    private handleAttackingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        if (this.getUnitIds().length === 0) {
            // TODO: disband directly (we no longer retreat when losing)
            this.state = AttackMissionState.Retreating;
            return noop();
        }

        const foundTargets = matchAwareness
            .getHostilesNearPoint2d(this.attackArea, this.radius)
            .map((unit) => gameApi.getUnitData(unit.unitId))
            .filter((unit) => !isOwnedByNeutral(unit)) as UnitData[];

        this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, this, matchAwareness, this.logger);

        if (foundTargets.length > 0) {
            this.lastTargetSeenAt = gameApi.getCurrentTick();
            this.hasPickedNewTarget = false;
        } else if (gameApi.getCurrentTick() > this.lastTargetSeenAt + NO_TARGET_IDLE_TIMEOUT_TICKS) {
            return disbandMission(AttackFailReason.NoTargets);
        } else if (
            !this.hasPickedNewTarget &&
            gameApi.getCurrentTick() > this.lastTargetSeenAt + NO_TARGET_RETARGET_TICKS
        ) {
            const newTarget = generateTarget(gameApi, playerData, matchAwareness);
            if (newTarget) {
                this.squad.setAttackArea(newTarget);
                this.hasPickedNewTarget = true;
            }
        }

        return noop();
    }

    private handleRetreatingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        this.getUnits(gameApi).forEach((unitId) => {
            const moveAction = manageMoveMicro(unitId, matchAwareness.getMainRallyPoint());
            if (moveAction) {
                actionBatcher.push(moveAction);
            }
        });
        return disbandMission();
    }

    public getGlobalDebugText(): string | undefined {
        return this.squad.getGlobalDebugText() ?? "<none>";
    }

    public getState() {
        return this.state;
    }

    // This mission can give up its units while preparing.
    public isUnitsLocked(): boolean {
        return this.state !== AttackMissionState.Preparing;
    }

    public getPriority() {
        return this.priority;
    }
}

// Calculates the weight for initiating an attack on the position of a unit or building.
// This is separate from unit micro; the squad will be ordered to attack in the vicinity of the point.
const getTargetWeight: (unitData: UnitData, tryFocusHarvester: boolean) => number = (unitData, tryFocusHarvester) => {
    if (tryFocusHarvester && unitData.rules.harvester) {
        return 100000;
    } else if (unitData.type === ObjectType.Building) {
        return unitData.maxHitPoints * 10;
    } else {
        return unitData.maxHitPoints;
    }
};

export function generateTarget(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    includeBaseLocations: boolean = false,
): Vector2 | null {
    // Randomly decide between harvester and base.
    try {
        const tryFocusHarvester = gameApi.generateRandomInt(0, 1) === 0;
        const enemyUnits = gameApi
            .getVisibleUnits(playerData.name, "enemy")
            .map((unitId) => gameApi.getUnitData(unitId))
            .filter((u) => !!u && u.hitPoints > 0 && gameApi.getPlayerData(u.owner).isCombatant) as UnitData[];

        const maxUnit = maxBy(enemyUnits, (u) => getTargetWeight(u, tryFocusHarvester));
        if (maxUnit) {
            return new Vector2(maxUnit.tile.rx, maxUnit.tile.ry);
        }
        if (includeBaseLocations) {
            const mapApi = gameApi.mapApi;
            const enemyPlayers = gameApi
                .getPlayers()
                .map(gameApi.getPlayerData)
                .filter((otherPlayer) => !gameApi.areAlliedPlayers(playerData.name, otherPlayer.name));

            const unexploredEnemyLocations = enemyPlayers.filter((otherPlayer) => {
                const tile = mapApi.getTile(otherPlayer.startLocation.x, otherPlayer.startLocation.y);
                if (!tile) {
                    return false;
                }
                return !mapApi.isVisibleTile(tile, playerData.name);
            });
            if (unexploredEnemyLocations.length > 0) {
                const idx = gameApi.generateRandomInt(0, unexploredEnemyLocations.length - 1);
                return unexploredEnemyLocations[idx].startLocation;
            }
        }
    } catch (err) {
        // There's a crash here when accessing a building that got destroyed. Will catch and ignore or now.
        return null;
    }
    return null;
}

// Number of ticks between attacking visible targets.
const VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS = 120;

// Number of ticks between attacking "bases" (enemy starting locations).
const BASE_ATTACK_COOLDOWN_TICKS = 1800;

const ATTACK_MISSION_INITIAL_PRIORITY = 1;

export class DynamicAttackMissionFactory implements MissionFactory {
    constructor(private lastAttackAt: number = -VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS) {}

    getName(): string {
        return "DynamicAttackMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        productionApi: ProductionApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        if (gameApi.getCurrentTick() < this.lastAttackAt + VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS) {
            return;
        }

        // can only have one attack 'preparing' at once.
        if (
            missionController
                .getMissions()
                .some(
                    (mission): mission is AttackMission =>
                        mission instanceof AttackMission && mission.getState() === AttackMissionState.Preparing,
                )
        ) {
            return;
        }

        const attackRadius = 10;

        const includeEnemyBases = gameApi.getCurrentTick() > this.lastAttackAt + BASE_ATTACK_COOLDOWN_TICKS;

        const attackArea = generateTarget(gameApi, playerData, matchAwareness, includeEnemyBases);

        if (!attackArea) {
            return;
        }

        const squadName = "attack_" + gameApi.getCurrentTick();

        const composition: UnitComposition = calculateTargetComposition(gameApi, playerData, matchAwareness);

        const tryAttack = missionController.addMission(
            new AttackMission(
                squadName,
                ATTACK_MISSION_INITIAL_PRIORITY,
                matchAwareness.getMainRallyPoint(),
                attackArea,
                attackRadius,
                logger,
                composition,
            ).then((unitIds, reason) => {
                missionController.addMission(
                    new RetreatMission(
                        "retreat-from-" + squadName + gameApi.getCurrentTick(),
                        matchAwareness.getMainRallyPoint(),
                        unitIds,
                        logger,
                    ),
                );
            }),
        );
        if (tryAttack) {
            this.lastAttackAt = gameApi.getCurrentTick();
        }
    }

    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission<any>,
        failureReason: any,
        missionController: MissionController,
    ): void {}
}
