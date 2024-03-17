import { GuardAreaStep } from "../triggers/scriptTypes.js";
import { CombatSquad } from "../squads/combatSquad.js";
import { ScriptStepHandler, OnStepArgs, ScriptStepResult } from "./scripts";

export class GuardAreaHandler implements ScriptStepHandler {
    private endAt: number | null = null;

    private squad: CombatSquad | null = null;

    onStart({ scriptStep, gameApi }: OnStepArgs): void {
        const entry = scriptStep as GuardAreaStep;
        // there are 15 ticks per second at normal speed, and each unit of time in the step is 6 seconds (1/10 of a minute).
        // source: https://modenc.renegadeprojects.com/ScriptTypes/ScriptActions#fn3
        const guardTimeInFrames = entry.time * 6 * 15;
        this.endAt = gameApi.getCurrentTick() + guardTimeInFrames;
    }

    onStep({
        gameApi,
        mission,
        actionsApi,
        actionBatcher,
        playerData,
        matchAwareness,
        logger,
    }: OnStepArgs): ScriptStepResult {
        if (!this.endAt || gameApi.getCurrentTick() > this.endAt) {
            return { type: "step" };
        }

        const currentPoint = mission.getCenterOfMass();

        if (!currentPoint) {
            return { type: "disband" };
        }

        if (!this.squad) {
            this.squad = new CombatSquad(currentPoint);
        }

        this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, mission, matchAwareness, logger);

        return { type: "repeat" };
    }
}
