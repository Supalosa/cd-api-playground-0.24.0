import { ActionsApi, GameApi, OrderType, PlayerData } from "@chronodivide/game-api";
import { MatchAwareness } from "../../../awareness.js";
import { JumpToLineStep, ResolvedScriptTypeEntry, ScriptTypeAction } from "../triggers/scriptTypes.js";
import { ActionBatcher } from "../../actionBatcher.js";
import { DebugLogger } from "../../../common/utils.js";
import { Mission } from "../../mission.js";

import { MoveToHandler, MoveToTargetType } from "./moveToBuildingHandlers.js";
import { GatherOrRegroupHandler, GatherOrRegroup } from "./gatherRegroupHandlers.js";
import { GuardAreaHandler } from "./guardAreaHandler.js";
import { AttackQuarryTypeHandler } from "./attackQuarryTypeHandler.js";
import { AssignNewMissionHandler } from "./assignNewMissionHandler.js";

type Repeat = {
    type: "repeat";
};

// Move on to next.
type Step = {
    type: "step";
};

type Disband = {
    type: "disband";
};

type GoToLine = {
    type: "goToLine";
    line: number;
};

export type ScriptStepResult = Repeat | Step | Disband | GoToLine;

// Using an argument object here to make it easier to add more arguments in the future.
export type OnStepArgs = {
    scriptStep: ResolvedScriptTypeEntry;
    gameApi: GameApi;
    mission: Mission<any>;
    actionsApi: ActionsApi;
    actionBatcher: ActionBatcher;
    playerData: PlayerData;
    matchAwareness: MatchAwareness;
    logger: DebugLogger;
};

export interface ScriptStepHandler {
    onStart?(args: OnStepArgs): void;

    onStep(args: OnStepArgs): ScriptStepResult;

    onCleanup?(args: OnStepArgs): void;
}

export const SCRIPT_STEP_HANDLERS = new Map<ScriptTypeAction, () => ScriptStepHandler>([
    [ScriptTypeAction.AttackQuarryType, () => new AttackQuarryTypeHandler()],
    [ScriptTypeAction.GuardArea, () => new GuardAreaHandler()],
    [ScriptTypeAction.JumpToLine, () => new JumpToLineHandler()],
    [ScriptTypeAction.AssignNewMission, () => new AssignNewMissionHandler()],
    [ScriptTypeAction.LoadOntoTransport, () => new LoadOntoTransportHandler()],
    [ScriptTypeAction.MoveToEnemyStructure, () => new MoveToHandler(MoveToTargetType.Enemy)],
    [ScriptTypeAction.RegisterSuccess, () => new RegisterSuccess()],
    [ScriptTypeAction.GatherAtEnemyBase, () => new GatherOrRegroupHandler(GatherOrRegroup.Gather)],
    [ScriptTypeAction.RegroupAtFriendlyBase, () => new GatherOrRegroupHandler(GatherOrRegroup.Regroup)],
    [ScriptTypeAction.MoveToFriendlyStructure, () => new MoveToHandler(MoveToTargetType.Friendly)],
]);

/**
 * TODO for implementation:
   8 12 -> Unload
   21 1 -> Scatter
   43 13 -> WaitUntilFullyLoaded
   46 35 -> AttackEnemyStructure
   55 7 -> ActivateIronCurtainOnTaskForce
   57 2 -> ChronoshiftTaskForceToTargetType
 */

class JumpToLineHandler implements ScriptStepHandler {
    onStep({ scriptStep }: OnStepArgs): GoToLine {
        const args = scriptStep as JumpToLineStep;
        return { type: "goToLine", line: args.line - 1 };
    }
}

// No-op until we have mutable trigger weighting.
class RegisterSuccess implements ScriptStepHandler {
    onStep(): Step {
        return { type: "step" };
    }
}

const LOAD_TIME_LIMIT = 300;

class LoadOntoTransportHandler implements ScriptStepHandler {
    private transporters: number[] | null = null;
    private transporteesToTransport: Map<number, number> = new Map();

    private abortAt: number | null = null;

    onStart({ gameApi, mission, actionsApi }: OnStepArgs) {
        // Decide what is being transported when we start the step.
        const allUnits = mission.getUnits(gameApi);

        const transportUnits = allUnits.filter((u) => u.rules.passengers > 0);
        this.transporters = transportUnits.map((u) => u.id);

        // Create mapping of transportId => Passenger Slots
        const remainingSizes = new Map<number, number>(transportUnits.map((t) => [t.id, t.rules.passengers]));

        // Assign transportees to target transport.
        // Knapsack problem but can't be bothered right now.
        const transportedUnits = allUnits.filter((u) => u.rules.size > 0 && !this.transporters?.includes(u.id));

        while (transportedUnits.length > 0 && remainingSizes.size > 0) {
            const unit = transportedUnits.pop()!;
            const fittingTransport =
                [...remainingSizes.entries()].filter(([, size]) => size >= unit.rules.size).pop() ?? null;
            if (fittingTransport) {
                const [transportId, slots] = fittingTransport;
                this.transporteesToTransport.set(unit.id, transportId);
                remainingSizes.set(transportId, slots - unit.rules.size);
                if (slots - unit.rules.size === 0) {
                    remainingSizes.delete(transportId);
                }
            }
        }
        // Unload all units from transports. This crashes
        actionsApi.orderUnits(this.transporters, OrderType.DeploySelected);

        this.abortAt = gameApi.getCurrentTick() + LOAD_TIME_LIMIT;
    }

    onStep({ gameApi, actionsApi }: OnStepArgs): Step | Repeat {
        if (
            !this.transporters ||
            !this.transporteesToTransport ||
            (this.abortAt && gameApi.getCurrentTick() > this.abortAt)
        ) {
            return { type: "step" };
        }

        this.transporteesToTransport.forEach((unitId, transportId) => {
            actionsApi.orderUnits([transportId], OrderType.EnterTransport, unitId);
        });

        return { type: "repeat" };
    }
}
