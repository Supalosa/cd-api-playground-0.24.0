import { CombatSquad } from "../squads/combatSquad.js";
import { ScriptStepHandler, OnStepArgs, ScriptStepResult } from "./scripts";
import {
    FactoryType,
    GameApi,
    GameObjectData,
    ObjectType,
    PlayerData,
    TechnoRules,
    Vector2,
} from "@chronodivide/game-api";
import { AttackQuarryTypeStep, QuarryType } from "../triggers/scriptTypes.js";
import { maxBy } from "../../../common/utils.js";
import { getTechnoRulesForUnit } from "../../../common/rulesCache.js";

const TARGET_RECALCULATE_INTERVAL = 25;

// A unit within this radius of the player start location is considered a threat, for the purposes of QuarryType.BaseThreats.
const BASE_THREAT_RANGE = 30;

// This is basically https://modenc.renegadeprojects.com/TargetDistanceCoefficientDefault
// But we assume the TargetDistanceCoefficientDefault is set to -10, i.e. about 39 cells
const TARGET_DISTANCE_COEFFICIENT = 39;

export class AttackQuarryTypeHandler implements ScriptStepHandler {
    private squad: CombatSquad | null = null;

    private target: GameObjectData | null = null;

    private lastTargetRecalculationAt = 0;

    private recalculateTarget(
        gameApi: GameApi,
        playerData: PlayerData,
        targetPlayer: string,
        quarryType: QuarryType,
        centerOfMass: Vector2,
    ): GameObjectData | null {
        const matchesQuarryType = (rules: TechnoRules): boolean => {
            switch (quarryType) {
                case QuarryType.None:
                    return false;
                case QuarryType.Anything:
                    return true;
                case QuarryType.Structures:
                    return rules.type === ObjectType.Building;
                case QuarryType.Harvesters:
                    return rules.harvester;
                case QuarryType.Infantry:
                    return rules.type === ObjectType.Infantry;
                case QuarryType.Vehicles:
                    return rules.type === ObjectType.Vehicle;
                case QuarryType.Factories:
                    return rules.factory !== FactoryType.None;
                case QuarryType.BaseDefences:
                    return rules.isBaseDefense;
                case QuarryType.BaseThreats:
                    return true; // gets filtered later
                case QuarryType.PowerPlants:
                    return rules.power > 0;
                case QuarryType.Occupiable:
                    return rules.canBeOccupied;
                case QuarryType.TechBuildings:
                    return rules.needsEngineer;
            }
        };

        const filterCandidates = (unit: GameObjectData): boolean => {
            // This is called on the result of getGameObjectData, which is more expensive
            if (quarryType === QuarryType.BaseThreats) {
                const position = new Vector2(unit.tile.rx, unit.tile.ry);
                return position.distanceTo(playerData.startLocation) <= BASE_THREAT_RANGE;
            }
            return true;
        };

        const targetCandidates = gameApi
            .getVisibleUnits(targetPlayer, "self", (r) => matchesQuarryType(r))
            .map((unitId) => gameApi.getGameObjectData(unitId))
            .filter((gO): gO is GameObjectData => !!gO && filterCandidates(gO));

        const getWeightForUnit = (unit: GameObjectData): number => {
            const distance = new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(centerOfMass);
            // See https://modenc.renegadeprojects.com/TargetDistanceCoefficientDefault for algorithm
            if (distance <= TARGET_DISTANCE_COEFFICIENT) {
                // Nearest unit wins, but specialThreatValue adds a bit more threat
                const specialFactor = getTechnoRulesForUnit(gameApi, unit.id)?.specialThreatValue ?? 0;
                return -distance + specialFactor;
            } else {
                // This looks odd, but apparently the AI targets the first unit it sees if there are no objects in range.
                // This populates the candidates with very low-value weights that will only surface if there are no candidates in range.
                return -10000 - unit.id;
            }
        };

        return maxBy(targetCandidates, getWeightForUnit);
    }

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
        const args = scriptStep as AttackQuarryTypeStep;
        const { quarryType } = args;

        const targetPlayer = matchAwareness.getTargetedPlayer();

        if (!targetPlayer) {
            return { type: "step" };
        }

        const centerOfMass = mission.getCenterOfMass();
        if (!centerOfMass) {
            return { type: "step" };
        }

        if (!this.target || gameApi.getCurrentTick() > this.lastTargetRecalculationAt + TARGET_RECALCULATE_INTERVAL) {
            this.target = this.recalculateTarget(gameApi, playerData, targetPlayer, quarryType, centerOfMass);
            this.lastTargetRecalculationAt = gameApi.getCurrentTick();
        }

        if (!this.target) {
            // No targets available, move on
            return { type: "step" };
        }

        const targetPosition = new Vector2(this.target.tile.rx, this.target.tile.ry);

        // Use a CombatSquad to move the units there. It's not perfect, we'll create dedicated squad behaviour soon.
        if (!this.squad) {
            this.squad = new CombatSquad(targetPosition);
        }
        this.squad.setAttackArea(targetPosition);

        this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, mission, matchAwareness, logger);

        return { type: "repeat" };
    }
}
