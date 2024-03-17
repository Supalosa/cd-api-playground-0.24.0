import { CombatSquad } from "../squads/combatSquad.js";
import { ScriptStepHandler, OnStepArgs, ScriptStepResult } from "./scripts";

export enum GatherOrRegroup {
    Gather,
    Regroup,
}

export class GatherOrRegroupHandler implements ScriptStepHandler {
    constructor(private mode: GatherOrRegroup) {}

    private squad: CombatSquad | null = null;

    onStep({
        gameApi,
        mission,
        actionsApi,
        actionBatcher,
        playerData,
        matchAwareness,
        logger,
    }: OnStepArgs): ScriptStepResult {
        const targetPoint =
            this.mode === GatherOrRegroup.Gather
                ? matchAwareness.getEnemyGatherPoint()
                : matchAwareness.getMainRallyPoint();
        if (!targetPoint) {
            // Gather point may not exist at the start of the game, which is before any of these missions are created, but you never know....
            return { type: "repeat" };
        }

        if (!this.squad) {
            this.squad = new CombatSquad(targetPoint);
        }

        // Squads have their own 'gather' logic which we may need to handle separately, but this should point them in the right direction.
        this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, mission, matchAwareness, logger);

        const centerOfMassDistance = mission.getCenterOfMass()?.distanceTo(targetPoint) ?? Number.MAX_VALUE;
        const maxDistanceToCenterOfMass = mission.getMaxDistanceToCenterOfMass() ?? Number.MAX_VALUE;

        // Maybe we should use RelaxedStray but I think this will work for now.
        if (centerOfMassDistance < 10 && maxDistanceToCenterOfMass < mission.getUnitIds().length * 5) {
            return { type: "step" };
        }

        return { type: "repeat" };
    }
}
