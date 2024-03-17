import { GameApi, GameObjectData, OrderType, Tile, Vector2 } from "@chronodivide/game-api";
import { BuildingWithPropertyArguments, BuildingWithPropertySelectionMode } from "../triggers/scriptTypes.js";
import { maxBy } from "../../../common/utils.js";
import { CombatSquad } from "../squads/combatSquad.js";
import { ScriptStepHandler, OnStepArgs, ScriptStepResult } from "./scripts";
import { BatchableAction } from "../../actionBatcher.js";
import { getTechnoRulesForUnit } from "../../../common/rulesCache.js";

export enum MoveToTargetType {
    Friendly,
    Enemy,
}

function recalculateTarget(
    gameApi: GameApi,
    selectionMode: BuildingWithPropertySelectionMode,
    centerOfMass: Vector2,
    targetPlayer: string,
    buildingType: string,
): GameObjectData | null {
    const getWeightForUnit = (unit: GameObjectData): number => {
        switch (selectionMode) {
            case BuildingWithPropertySelectionMode.Farthest:
                return new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(centerOfMass);
            case BuildingWithPropertySelectionMode.Nearest:
                return -new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(centerOfMass);
            case BuildingWithPropertySelectionMode.HighestThreat:
            case BuildingWithPropertySelectionMode.LeastThreat:
                return THREAT_NOT_IMPLEMENTED_DEFAULT_VALUE + unit.id / 1000;
        }
    };

    const targetCandidates = gameApi
        .getVisibleUnits(targetPlayer, "self", (r) => r.name === buildingType)
        .map((unitId) => gameApi.getGameObjectData(unitId))
        .filter((unit): unit is GameObjectData => !!unit);

    return maxBy(targetCandidates, getWeightForUnit);
}

// Threat isn't implemented.
const THREAT_NOT_IMPLEMENTED_DEFAULT_VALUE = 100;

const MOVE_TO_RECALCULATE_INTERVAL = 150;

// Move to friendly unit
export class MoveToHandler implements ScriptStepHandler {
    private squad: CombatSquad | null = null;

    private target: GameObjectData | null = null;

    private lastTargetRecalculationAt = 0;

    constructor(private mode: MoveToTargetType) {}

    onStep({
        scriptStep,
        gameApi,
        mission,
        actionsApi,
        actionBatcher,
        playerData,
        matchAwareness,
        logger,
    }: OnStepArgs): ScriptStepResult {
        const args = scriptStep as BuildingWithPropertyArguments;
        const { buildingType, selectionMode } = args;

        const targetPlayer =
            this.mode === MoveToTargetType.Friendly ? playerData.name : matchAwareness.getTargetedPlayer();

        if (!targetPlayer) {
            return { type: "step" };
        }

        const centerOfMass = mission.getCenterOfMass();
        if (!centerOfMass) {
            return { type: "step" };
        }

        if (!this.target || gameApi.getCurrentTick() > this.lastTargetRecalculationAt + MOVE_TO_RECALCULATE_INTERVAL) {
            this.target = recalculateTarget(gameApi, selectionMode, centerOfMass, targetPlayer, buildingType);
            this.lastTargetRecalculationAt = gameApi.getCurrentTick();
        }

        if (!this.target) {
            // move on
            return { type: "step" };
        }

        const targetPosition = new Vector2(this.target.tile.rx, this.target.tile.ry);

        // Use a CombatSquad to move the units there. It's not perfect, we'll create dedicated squad behaviour soon.
        if (!this.squad) {
            this.squad = new CombatSquad(targetPosition);
        }
        this.squad.setAttackArea(targetPosition);

        this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, mission, matchAwareness, logger);

        // If at least one unit is next to the target, step forward.
        const { width, height } = this.target.foundation;
        const hasAdjacentUnit = mission
            .getUnitIds()
            .map((unitId) => gameApi.getGameObjectData(unitId)?.tile)
            .some((tile?: Tile) => {
                if (!tile) {
                    return false;
                }
                return (
                    tile.rx >= targetPosition.x - 1 &&
                    tile.rx <= targetPosition.x + width + 2 &&
                    tile.ry >= targetPosition.y - 1 &&
                    tile.ry <= targetPosition.y + height + 2
                );
            });

        if (hasAdjacentUnit) {
            return { type: "step" };
        }

        return { type: "repeat" };
    }
}

const ATTACK_ENEMY_STRUCTURE_LIMIT = 900;

export class AttackEnemyStructureHandler implements ScriptStepHandler {
    private target: GameObjectData | null = null;

    private lastTargetRecalculationAt = 0;
    private abortAt: number | null = null;

    onStart({ gameApi }: OnStepArgs) {
        this.abortAt = gameApi.getCurrentTick() + ATTACK_ENEMY_STRUCTURE_LIMIT;
    }

    onStep({ scriptStep, gameApi, mission, actionBatcher, matchAwareness }: OnStepArgs): ScriptStepResult {
        if (this.abortAt && gameApi.getCurrentTick() > this.abortAt) {
            return { type: "step" };
        }

        const args = scriptStep as BuildingWithPropertyArguments;
        const { buildingType, selectionMode } = args;

        const targetPlayer = matchAwareness.getTargetedPlayer();

        if (!targetPlayer) {
            return { type: "step" };
        }

        const centerOfMass = mission.getCenterOfMass();
        if (!centerOfMass) {
            // maybe all units died
            return { type: "step" };
        }

        if (!this.target || gameApi.getCurrentTick() > this.lastTargetRecalculationAt + MOVE_TO_RECALCULATE_INTERVAL) {
            this.target = recalculateTarget(gameApi, selectionMode, centerOfMass, targetPlayer, buildingType);
            this.lastTargetRecalculationAt = gameApi.getCurrentTick();
        }

        if (this.target) {
            const targetId = this.target.id;
            const targetRules = getTechnoRulesForUnit(gameApi, targetId);
            mission.getUnits(gameApi).forEach((unit) => {
                if ((unit.rules.infiltrate && unit.rules.agent) || (targetRules?.canC4 && unit.rules.c4)) {
                    actionBatcher.push(BatchableAction.toTargetId(unit.id, OrderType.Attack, targetId));
                } else if (unit.rules.engineer && targetRules?.capturable) {
                    actionBatcher.push(BatchableAction.toTargetId(unit.id, OrderType.Capture, targetId));
                } else if (unit.rules.occupier && targetRules?.canBeOccupied) {
                    actionBatcher.push(BatchableAction.toTargetId(unit.id, OrderType.Occupy, targetId));
                }
            });
        }

        return { type: "repeat" };
    }
}
