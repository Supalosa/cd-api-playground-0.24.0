import { ActionsApi, GameApi, OrderType, PlayerData } from "@chronodivide/game-api";
import { MatchAwareness } from "../../../awareness.js";
import { JumpToLineStep, ResolvedScriptTypeEntry, ScriptTypeAction } from "../triggers/scriptTypes.js";
import { ActionBatcher } from "../../actionBatcher.js";
import { DebugLogger } from "../../../common/utils.js";
import { Mission } from "../../mission.js";

import { AttackEnemyStructureHandler, MoveToHandler, MoveToTargetType } from "./moveToBuildingHandlers.js";
import { GatherOrRegroupHandler, GatherOrRegroup } from "./gatherRegroupHandlers.js";
import { GuardAreaHandler } from "./guardAreaHandler.js";
import { AttackQuarryTypeHandler } from "./attackQuarryTypeHandler.js";
import { AssignNewMissionHandler } from "./assignNewMissionHandler.js";
import { Script } from "vm";

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
    [ScriptTypeAction.Unload, () => new UnloadHandler()],
    [ScriptTypeAction.JumpToLine, () => new JumpToLineHandler()],
    [ScriptTypeAction.AssignNewMission, () => new AssignNewMissionHandler()],
    [ScriptTypeAction.LoadOntoTransport, () => new LoadOntoTransportHandler()],
    [ScriptTypeAction.Scatter, () => new ScatterHandler()],
    [ScriptTypeAction.WaitUntilFullyLoaded, () => new WaitUntilFullyLoadedHandler()],
    [ScriptTypeAction.AttackEnemyStructure, () => new AttackEnemyStructureHandler()],
    [ScriptTypeAction.MoveToEnemyStructure, () => new MoveToHandler(MoveToTargetType.Enemy)],
    [ScriptTypeAction.RegisterSuccess, () => new RegisterSuccess()],
    [ScriptTypeAction.GatherAtEnemyBase, () => new GatherOrRegroupHandler(GatherOrRegroup.Gather)],
    [ScriptTypeAction.RegroupAtFriendlyBase, () => new GatherOrRegroupHandler(GatherOrRegroup.Regroup)],
    [ScriptTypeAction.MoveToFriendlyStructure, () => new MoveToHandler(MoveToTargetType.Friendly)],
]);

/**
 * TODO for implementation:
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

const UNLOAD_TIME_LIMIT = 150;
class UnloadHandler implements ScriptStepHandler {
    private abortAt: number | null = null;
    onStart({ gameApi }: OnStepArgs): void {
        this.abortAt = gameApi.getCurrentTick() + UNLOAD_TIME_LIMIT;
    }

    onStep({ gameApi, mission, actionsApi }: OnStepArgs): Step | Repeat {
        if (this.abortAt && gameApi.getCurrentTick() > this.abortAt) {
            return { type: "step" };
        }

        actionsApi.orderUnits(mission.getUnitIds(), OrderType.DeploySelected);
        return { type: "repeat" };
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
        // Unload all units from transports.
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

        this.transporteesToTransport.forEach((transportId, unitId) => {
            actionsApi.orderUnits([unitId], OrderType.EnterTransport, transportId);
        });

        return { type: "repeat" };
    }
}

const SCATTER_TIME_LIMIT = 60;
class ScatterHandler implements ScriptStepHandler {
    private abortAt: number | null = null;
    onStart({ gameApi }: OnStepArgs): void {
        this.abortAt = gameApi.getCurrentTick() + SCATTER_TIME_LIMIT;
    }
    onStep({ gameApi, actionsApi, mission }: OnStepArgs): Step | Repeat {
        if (this.abortAt && gameApi.getCurrentTick() > this.abortAt) {
            return { type: "step" };
        }

        actionsApi.orderUnits(mission.getUnitIds(), OrderType.Scatter);

        return { type: "repeat" };
    }
}

const WAIT_FOR_LOAD_LIMIT = 600;

// note: in theory this could stall forever if any of the transported units are killed on the way, and we don't
// produce/procure replacements while stepping
class WaitUntilFullyLoadedHandler implements ScriptStepHandler {
    private transporters: number[] | null = null;

    private abortAt: number | null = null;

    onStart({ gameApi, mission }: OnStepArgs): void {
        // Decide what is being transported when we start the step.
        const allUnits = mission.getUnits(gameApi);

        const transportUnits = allUnits.filter((u) => u.rules.passengers > 0);
        this.transporters = transportUnits.map((u) => u.id);
        this.abortAt = gameApi.getCurrentTick() + WAIT_FOR_LOAD_LIMIT;
    }

    onStep({ gameApi, actionsApi, mission }: OnStepArgs): Step | Repeat {
        if (!this.transporters) {
            return { type: "step" };
        }

        if (this.abortAt && gameApi.getCurrentTick() > this.abortAt) {
            // Unload all units from transports.
            actionsApi.orderUnits(this.transporters, OrderType.DeploySelected);
            return { type: "step" };
        }

        // this is NOT correct but we don't currently have a way to check that the transports are full, so we just check
        // if the only members of the mission are the transporters.
        if (!mission.getUnits(gameApi).some((u) => u.rules.passengers === 0)) {
            return { type: "step" };
        }

        return { type: "repeat" };
    }
}
