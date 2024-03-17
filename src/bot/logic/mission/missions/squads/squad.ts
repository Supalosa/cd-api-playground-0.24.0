import { ActionsApi, GameApi, PlayerData } from "@chronodivide/game-api";
import { ActionBatcher } from "../../actionBatcher";
import { Mission, MissionAction } from "../../mission";
import { MatchAwareness } from "../../../awareness";
import { DebugLogger } from "../../../common/utils";

export interface Squad {
    onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        actionBatcher: ActionBatcher,
        playerData: PlayerData,
        mission: Mission<any>,
        matchAwareness: MatchAwareness,
        logger: DebugLogger,
    ): void;

    getGlobalDebugText(): string | undefined;
}
