import { GameApi, PlayerData, TechnoRules, Vector2 } from "@chronodivide/game-api";
import { getPointTowardsOtherPoint } from "../map/map.js";
import { GlobalThreat } from "../threat/threat.js";
import { AiBuildingRules, getDefaultPlacementLocation, numBuildingsOwnedOfType } from "./buildingRules.js";

export class AntiAirStaticDefence implements AiBuildingRules {
    constructor(
        private basePriority: number,
        private baseAmount: number,
        private airStrength: number,
        private limit: number,
    ) {}

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        // Prefer front towards enemy.
        let startLocation = playerData.startLocation;
        let players = game.getPlayers();
        let enemyFacingLocationCandidates: Vector2[] = [];
        for (let i = 0; i < players.length; ++i) {
            let playerName = players[i];
            if (playerName == playerData.name) {
                continue;
            }
            let enemyPlayer = game.getPlayerData(playerName);
            enemyFacingLocationCandidates.push(
                getPointTowardsOtherPoint(game, startLocation, enemyPlayer.startLocation, 4, 16, 1.5),
            );
        }
        let selectedLocation =
            enemyFacingLocationCandidates[Math.floor(game.generateRandom() * enemyFacingLocationCandidates.length)];
        return getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 0);
    }

    getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number {
        const numOwned = numBuildingsOwnedOfType(game, playerData, technoRules);
        if (numOwned >= this.limit) {
            return 0;
        }
        if (threatCache) {
            let denominator = threatCache.totalAvailableAntiAirFirepower + this.airStrength;
            if (threatCache.totalOffensiveAirThreat > denominator * 1.1) {
                return this.basePriority * (threatCache.totalOffensiveAirThreat / Math.max(1, denominator));
            } else {
                return 0;
            }
        }
        const strengthPerCost = (this.airStrength / technoRules.cost) * 1000;
        return this.basePriority * (1.0 - numOwned / this.baseAmount) * strengthPerCost;
    }

    getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number | null {
        return null;
    }
}
