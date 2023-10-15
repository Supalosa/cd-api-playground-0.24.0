import { GameApi, PlayerData } from "@chronodivide/game-api";
import { GlobalThreat } from "../../threat/threat.js";
import { Mission } from "../mission.js";
import { ExpansionSquad } from "../../squad/behaviours/expansionSquad.js";
import { MissionFactory } from "../missionFactories.js";
import { OneTimeMission } from "./oneTimeMission.js";
import { MatchAwareness } from "../../awareness.js";
import { AttackFailReason, AttackMission } from "./attackMission.js";
import { MissionController } from "../missionController.js";

/**
 * A mission that tries to create an MCV (if it doesn't exist) and deploy it somewhere it can be deployed.
 */
export class ExpansionMission extends OneTimeMission {
    constructor(uniqueName: string, priority: number, selectedMcv: number | null) {
        super(uniqueName, priority, () => new ExpansionSquad(selectedMcv));
    }
}

export class ExpansionMissionFactory implements MissionFactory {
    getName(): string {
        return "ExpansionMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
    ): void {
        // At this point, only expand if we have a loose MCV.
        const mcvs = gameApi.getVisibleUnits(playerData.name, "self", (r) =>
            gameApi.getGeneralRules().baseUnit.includes(r.name)
        );
        mcvs.forEach((mcv) => {
            missionController.addMission(new ExpansionMission("expand-with-" + mcv, 100, mcv));
        });
    }

    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission,
        failureReason: undefined,
        missionController: MissionController,
    ): void {
    }
}
