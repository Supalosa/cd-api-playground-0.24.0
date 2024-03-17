// Used to group related actions together to minimise actionApi calls. For example, if multiple units

import { ActionsApi, GameApi, OrderType, Vector2 } from "@chronodivide/game-api";
import { groupBy } from "../common/utils.js";

// are ordered to move to the same location, all of them will be ordered to move in a single action.
export class BatchableAction {
    private constructor(
        private _unitId: number,
        private _orderType: OrderType,
        private _point?: Vector2,
        private _targetId?: number,
        // If you don't want this action to be swallowed by dedupe, provide a unique nonce
        private _nonce: number = 0,
        private _cooldown: number | null = null,
    ) {}

    static noTarget(unitId: number, orderType: OrderType, nonce: number = 0) {
        return new BatchableAction(unitId, orderType, undefined, undefined, nonce);
    }

    static toPoint(unitId: number, orderType: OrderType, point: Vector2, nonce: number = 0) {
        return new BatchableAction(unitId, orderType, point, undefined);
    }

    static toTargetId(unitId: number, orderType: OrderType, targetId: number, nonce: number = 0) {
        return new BatchableAction(unitId, orderType, undefined, targetId, nonce);
    }

    public get unitId() {
        return this._unitId;
    }

    public get orderType() {
        return this._orderType;
    }

    public get point() {
        return this._point;
    }

    public get targetId() {
        return this._targetId;
    }

    public get cooldown() {
        return this._cooldown;
    }

    // Debounce same action if submitted within a short period of time.
    public withCooldown(cooldownTicks: number) {
        return new BatchableAction(
            this._unitId,
            this._orderType,
            this._point,
            this._targetId,
            this._nonce,
            cooldownTicks,
        );
    }

    public isSameAs(other: BatchableAction) {
        if (this._unitId !== other._unitId) {
            return false;
        }
        if (this._orderType !== other._orderType) {
            return false;
        }
        if (this._point !== other._point) {
            return false;
        }
        if (this._targetId !== other._targetId) {
            return false;
        }
        if (this._nonce !== other._nonce) {
            return false;
        }
        if (this._cooldown !== other._cooldown) {
            return false;
        }
        return true;
    }
}

type BatchedActionData = {
    action: BatchableAction;
    executedAt: number;
};

/**
 * Push actions to be executed if the action is different from the last action we submitted to it.
 * Prevents spamming redundant orders, which affects performance and can also cause the unit to sit around doing nothing.
 */
export class ActionBatcher {
    private actions: BatchableAction[];

    private lastOrderExecuted: { [unitId: number]: BatchedActionData } = {};

    constructor() {
        this.actions = [];
    }

    push(action: BatchableAction) {
        this.actions.push(action);
    }

    resolve(gameApi: GameApi, actionsApi: ActionsApi) {
        const currentTick = gameApi.getCurrentTick();
        const filteredActions = this.actions.filter((action) => {
            const lastAction = this.lastOrderExecuted[action.unitId];
            return (
                !lastAction ||
                !lastAction.action.isSameAs(action) ||
                !lastAction.action.cooldown ||
                currentTick > lastAction.executedAt + lastAction.action.cooldown
            );
        });

        filteredActions.forEach((action) => {
            this.lastOrderExecuted[action.unitId] = {
                action,
                executedAt: currentTick,
            };
        });

        const groupedCommands = groupBy(filteredActions, (action) => action.orderType.valueOf().toString());
        const vectorToStr = (v: Vector2) => v.x + "," + v.y;
        const strToVector = (str: string) => {
            const [x, y] = str.split(",");
            return new Vector2(parseInt(x), parseInt(y));
        };

        // Group by command type.
        Object.entries(groupedCommands).forEach(([commandValue, commands]) => {
            // i hate this
            const commandType: OrderType = parseInt(commandValue) as OrderType;
            // Group by command target ID.
            const byTarget = groupBy(
                commands.filter((command) => !!command.targetId),
                (command) => command.targetId?.toString()!,
            );
            Object.entries(byTarget).forEach(([targetId, unitCommands]) => {
                actionsApi.orderUnits(
                    unitCommands.map((command) => command.unitId),
                    commandType,
                    parseInt(targetId),
                );
            });
            // Group by position (the vector is encoded as a string of the form "x,y")
            const byPosition = groupBy(
                commands.filter((command) => !!command.point),
                (command) => vectorToStr(command.point!),
            );
            Object.entries(byPosition).forEach(([point, unitCommands]) => {
                const vector = strToVector(point);
                actionsApi.orderUnits(
                    unitCommands.map((command) => command.unitId),
                    commandType,
                    vector.x,
                    vector.y,
                );
            });
            // Actions with no targets
            const noTargets = commands.filter((command) => !command.targetId && !command.point);
            if (noTargets.length > 0) {
                actionsApi.orderUnits(
                    noTargets.map((action) => action.unitId),
                    commandType,
                );
            }
        });
        this.actions = [];
    }
}
