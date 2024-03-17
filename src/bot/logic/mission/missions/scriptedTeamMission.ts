import { ActionsApi, GameApi, PlayerData } from "@chronodivide/game-api";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { MatchAwareness } from "../../awareness.js";
import { DebugLogger, countBy } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { UnitComposition } from "../../composition/common.js";
import { GeneralAiRules, ResolvedTeamType } from "./triggers/triggerManager.js";
import { OnStepArgs, SCRIPT_STEP_HANDLERS, ScriptStepHandler } from "./scripts/scripts.js";
import { ResolvedScriptTypeEntry } from "./triggers/scriptTypes.js";

export enum ScriptEndedReason {}

enum ScriptMissionState {
    Filling = 0,
    Executing = 1,
}

const MISSION_PRIORITY_RAMP = 1.01;
const MISSION_MAX_PRIORITY = 50;

type ExecutionData = {
    step: number;
    scriptStep: ResolvedScriptTypeEntry;
    handler: ScriptStepHandler;
};

/**
 * A mission that follows a script from the ai.ini file.
 */
export class ScriptedTeamMission extends Mission<ScriptEndedReason> {
    private dissolveUnfulfilledAt: number | null = null;

    private state: ScriptMissionState = ScriptMissionState.Filling;
    private priority: number;

    private executionData: ExecutionData | null = null;

    constructor(
        uniqueName: string,
        private teamType: ResolvedTeamType,
        private generalRules: GeneralAiRules,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        this.priority = teamType.priority;
        this.executionData = null;
    }

    _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        if (this.dissolveUnfulfilledAt === null) {
            this.dissolveUnfulfilledAt = gameApi.getCurrentTick() + this.generalRules.dissolveUnfilledTeamDelay;
        }

        switch (this.state) {
            case ScriptMissionState.Filling:
                return this.handleFillingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
            case ScriptMissionState.Executing:
                return this.handleExecutingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
        }
    }

    private handleFillingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        const currentComposition: UnitComposition = countBy(this.getUnitsGameObjectData(gameApi), (unit) => unit.name);

        const missingUnits = Object.entries(this.teamType.taskForce.units).filter(([unitType, targetAmount]) => {
            return !currentComposition[unitType] || currentComposition[unitType] < targetAmount;
        });

        if (this.dissolveUnfulfilledAt && gameApi.getCurrentTick() > this.dissolveUnfulfilledAt) {
            return disbandMission();
        }

        if (missingUnits.length > 0) {
            this.priority = Math.min(this.priority * MISSION_PRIORITY_RAMP, MISSION_MAX_PRIORITY);
            return requestUnits(
                missingUnits.map(([unitName]) => unitName),
                this.priority,
            );
        } else {
            // Transition to execution state.
            this.priority = this.teamType.priority;
            this.state = ScriptMissionState.Executing;
            const startingData = this.getExecutionData(0);
            if (!startingData) {
                this.logger(
                    `ERROR: disbanding ${this.getUniqueName()} because there is no handler for the first script step`,
                );
                return disbandMission();
            }
            const stepArgs = this.createStepArgs(
                startingData.scriptStep,
                gameApi,
                actionsApi,
                playerData,
                matchAwareness,
                actionBatcher,
            );
            startingData.handler.onStart?.(stepArgs);
            this.executionData = startingData;
            return this.handleExecutingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
        }
    }

    private getExecutionData(line: number): ExecutionData | null {
        const { actions } = this.teamType.script;
        const handlerFactory = SCRIPT_STEP_HANDLERS.get(actions[line].action);
        if (!handlerFactory) {
            const unhandledStep = actions[line];
            this.logger(`WARN: unhandled action ${unhandledStep.action}`);
            return null;
        }
        return {
            step: line,
            scriptStep: actions[line],
            handler: handlerFactory(),
        };
    }

    private createStepArgs(
        scriptStep: ResolvedScriptTypeEntry,
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): OnStepArgs {
        return {
            scriptStep,
            gameApi,
            mission: this,
            playerData,
            actionsApi,
            actionBatcher,
            matchAwareness,
            logger: this.logger,
        };
    }

    private handleExecutingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        if (this.executionData === null) {
            throw new Error(`Script ${this.getUniqueName()} entered executing state without any execution data`);
        }

        // Override: if the mission is destroyed, end the mission.
        if (this.getUnitIds().length === 0) {
        }
        const { step: stepIndex, handler: stepHandler, scriptStep } = this.executionData;

        const stepArgs = this.createStepArgs(
            scriptStep,
            gameApi,
            actionsApi,
            playerData,
            matchAwareness,
            actionBatcher,
        );
        const result = stepHandler.onStep(stepArgs);

        // the next step in the script may be overriden by a "goToLine" result.
        let nextStepIndex = stepIndex + 1;

        const assertNever = (_x: never) => {
            throw new Error("missed a case");
        };

        switch (result.type) {
            case "repeat":
                return noop();
            case "step":
                break;
            case "disband":
                return disbandMission();
            case "goToLine":
                if (result.line < 0 || result.line >= this.teamType.script.actions.length) {
                    throw new Error(
                        `Script for ${this.getUniqueName()} tried to send line outside of valid range (${result.line})`,
                    );
                }
                nextStepIndex = result.line;
                break;
            default:
                return assertNever(result);
        }

        if (nextStepIndex >= this.teamType.script.actions.length) {
            this.logger(`Disbanding ${this.getUniqueName()} because the script finished`);
            return disbandMission();
        }

        // Move to next step.
        this.executionData.handler.onCleanup?.(stepArgs);
        this.executionData = this.getExecutionData(nextStepIndex);

        if (!this.executionData) {
            this.logger(`Disbanding ${this.getUniqueName()} because it reached an unhandled step`);
            return disbandMission();
        }
        const newStepArgs = { ...stepArgs, scriptStep: this.executionData.scriptStep };
        this.executionData.handler.onStart?.(newStepArgs);
        return noop();
    }

    public getGlobalDebugText(): string | undefined {
        return "<none>";
    }

    public getState() {
        return this.state;
    }

    // This mission can give up its units while preparing.
    public isUnitsLocked(): boolean {
        return this.state !== ScriptMissionState.Filling;
    }

    public getPriority() {
        return this.priority;
    }
}
