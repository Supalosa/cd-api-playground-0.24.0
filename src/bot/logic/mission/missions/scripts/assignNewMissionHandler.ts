import { Vector2 } from "@chronodivide/game-api";
import { CombatSquad } from "../squads/combatSquad.js";
import { AssignableMissions, AssignNewMissionStep } from "../triggers/scriptTypes.js";
import { OnStepArgs, ScriptStepHandler, ScriptStepResult } from "./scripts.js";

export class AssignNewMissionHandler implements ScriptStepHandler {
    private squad: CombatSquad | null = null;
    private startingArea: Vector2 | null = null;

    onStart({ mission }: OnStepArgs) {
        this.startingArea = mission.getCenterOfMass();
    }

    onStep({
        gameApi,
        actionsApi,
        actionBatcher,
        playerData,
        matchAwareness,
        scriptStep,
        mission,
        logger,
    }: OnStepArgs): ScriptStepResult {
        const args = scriptStep as AssignNewMissionStep;

        if (!this.startingArea) {
            // Can happen if the mission starts with no units in it.
            return { type: "step" };
        }

        if (args.mission !== AssignableMissions.AreaGuard) {
            logger(`Assignable Mission ${args.mission} is not implemented, skipping mission`);
            return { type: "step" };
        }

        // These missions repeat in perpetuity until the task force is dead.
        const centerOfMass = mission.getCenterOfMass();
        if (!centerOfMass || mission.getUnitIds().length) {
            return { type: "step" };
        }

        if (!this.squad) {
            this.squad = new CombatSquad(this.startingArea);
        }

        if (args.mission === AssignableMissions.AreaGuard) {
            // this is the only mission...
            this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, mission, matchAwareness, logger);
        }

        return { type: "repeat" };
    }
}
