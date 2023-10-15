import { GameApi, ObjectType, PlayerData, Point2D, UnitData } from "@chronodivide/game-api";
import { SectorCache } from "./map/sector";
import { GlobalThreat } from "./threat/threat";
import { calculateGlobalThreat } from "../logic/threat/threatCalculator.js";
import { determineMapBounds, getDistanceBetweenPoints, getPointTowardsOtherPoint } from "../logic/map/map.js";
import { Circle, Quadtree, Rectangle } from "@timohausmann/quadtree-ts";

/**
 * The bot's understanding of the current state of the game.
 */
export interface MatchAwareness {
    /**
     * Returns the threat cache for the AI.
     */
    getThreatCache(): GlobalThreat | null;

    /**
     * Returns the sector visibility cache.
     */
    getSectorCache(): SectorCache;

    /**
     * Returns the enemy unit IDs in a certain radius of a point
     */
    getHostilesNearPoint2d(point: Point2D, radius: number): UnitPositionQuery[];

    getHostilesNearPoint(x: number, y: number, radius: number): UnitPositionQuery[];

    /**
     * Returns the main rally point for the AI, which updates every few ticks.
     */
    getMainRallyPoint(): Point2D;

    /**
     * Update the internal state of the Ai.
     * @param gameApi
     * @param playerData
     */
    onAiUpdate(gameApi: GameApi, playerData: PlayerData): void;

    /**
     * True if the AI should initiate an attack.
     */
    shouldAttack(): boolean;
}

const SECTORS_TO_UPDATE_PER_CYCLE = 8;

const RALLY_POINT_UPDATE_INTERVAL_TICKS = 60;

const THREAT_UPDATE_INTERVAL_TICKS = 30;

type QTUnit = Circle<number>;
export type UnitPositionQuery = { x: number; y: number; unitId: number };

const rebuildQuadtree = (quadtree: Quadtree<QTUnit>, units: UnitData[]) => {
    quadtree.clear();
    units.forEach((unit) => {
        quadtree.insert(new Circle<number>({ x: unit.tile.rx, y: unit.tile.ry, r: 1, data: unit.id }));
    });
};

export class MatchAwarenessImpl implements MatchAwareness {
    private _shouldAttack: boolean = false;

    private hostileQuadTree: Quadtree<QTUnit>;

    constructor(
        private threatCache: GlobalThreat | null,
        private sectorCache: SectorCache,
        private mainRallyPoint: Point2D,
        private logger: (message: string) => void,
    ) {
        const { x: width, y: height } = sectorCache.getMapBounds();
        this.hostileQuadTree = new Quadtree({ width, height });
    }

    getHostilesNearPoint2d(point: Point2D, radius: number): UnitPositionQuery[] {
        return this.getHostilesNearPoint(point.x, point.y, radius);
    }

    getHostilesNearPoint(searchX: number, searchY: number, radius: number): UnitPositionQuery[] {
        const intersections = this.hostileQuadTree.retrieve(new Circle({ x: searchX, y: searchY, r: radius }));
        return intersections
            .map(({ x, y, data: unitId }) => ({ x, y, unitId: unitId! }))
            .filter(({ x, y }) => getDistanceBetweenPoints({ x, y }, { x: searchX, y: searchY }) <= radius)
            .filter(({ unitId }) => !!unitId);
    }

    getThreatCache(): GlobalThreat | null {
        return this.threatCache;
    }
    getSectorCache(): SectorCache {
        return this.sectorCache;
    }
    getMainRallyPoint(): Point2D {
        return this.mainRallyPoint;
    }

    shouldAttack(): boolean {
        return this._shouldAttack;
    }

    private checkShouldAttack(threatCache: GlobalThreat, threatFactor: number) {
        let scaledGroundPower = Math.pow(threatCache.totalAvailableAntiGroundFirepower, 1.025);
        let scaledGroundThreat =
            (threatFactor * threatCache.totalOffensiveLandThreat + threatCache.totalDefensiveThreat) * 1.1;

        let scaledAirPower = Math.pow(threatCache.totalAvailableAirPower, 1.025);
        let scaledAirThreat =
            (threatFactor * threatCache.totalOffensiveAntiAirThreat + threatCache.totalDefensiveThreat) * 1.1;

        return scaledGroundPower > scaledGroundThreat || scaledAirPower > scaledAirThreat;
    }

    private isHostileUnit(unit: UnitData | undefined, hostilePlayerNames: string[]): boolean {
        if (!unit) {
            return false;
        }

        return hostilePlayerNames.includes(unit.owner);
    }

    onAiUpdate(game: GameApi, playerData: PlayerData): void {
        const sectorCache = this.sectorCache;

        sectorCache.updateSectors(game.getCurrentTick(), SECTORS_TO_UPDATE_PER_CYCLE, game.mapApi, playerData);

        let updateRatio = sectorCache?.getSectorUpdateRatio(game.getCurrentTick() - game.getTickRate() * 60);
        if (updateRatio && updateRatio < 1.0) {
            this.logger(`${updateRatio * 100.0}% of sectors updated in last 60 seconds.`);
        }

        const hostilePlayerNames = game
            .getPlayers()
            .map((name) => game.getPlayerData(name))
            .filter(
                (other) =>
                    other.name !== playerData.name &&
                    other.isCombatant &&
                    !game.areAlliedPlayers(playerData.name, other.name),
            )
            .map((other) => other.name);

        // Build the quadtree, if this is too slow we should consider doing this periodically.
        const hostileUnitIds = game.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => r.isSelectableCombatant || r.type === ObjectType.Building,
        );
        try {
            const hostileUnits = hostileUnitIds
                .map((id) => game.getUnitData(id))
                .filter((unit) => this.isHostileUnit(unit, hostilePlayerNames)) as UnitData[];

            rebuildQuadtree(this.hostileQuadTree, hostileUnits);
        } catch (err) {
            // Hack. Will be fixed soon.
            console.error(`caught error`, hostileUnitIds);
        }

        if (game.getCurrentTick() % THREAT_UPDATE_INTERVAL_TICKS == 0) {
            let visibility = sectorCache?.getOverallVisibility();
            if (visibility) {
                this.logger(`${Math.round(visibility * 1000.0) / 10}% of tiles visible. Calculating threat.`);
                // Update the global threat cache
                this.threatCache = calculateGlobalThreat(game, playerData, visibility);
                this.logger(
                    `Threat LAND: Them ${Math.round(this.threatCache.totalOffensiveLandThreat)}, us: ${Math.round(
                        this.threatCache.totalAvailableAntiGroundFirepower,
                    )}.`,
                );
                this.logger(
                    `Threat DEFENSIVE: Them ${Math.round(this.threatCache.totalDefensiveThreat)}, us: ${Math.round(
                        this.threatCache.totalDefensivePower,
                    )}.`,
                );
                this.logger(
                    `Threat AIR: Them ${Math.round(this.threatCache.totalOffensiveAirThreat)}, us: ${Math.round(
                        this.threatCache.totalAvailableAntiAirFirepower,
                    )}.`,
                );

                // As the game approaches 2 hours, be more willing to attack. (15 ticks per second)
                const gameLengthFactor = Math.max(0, 1.0 - game.getCurrentTick() / (15 * 7200.0));
                this.logger(`Game length multiplier: ${gameLengthFactor}`);

                if (!this._shouldAttack) {
                    // If not attacking, make it harder to switch to attack mode by multiplying the opponent's threat.
                    this._shouldAttack = this.checkShouldAttack(this.threatCache, 1.25 * gameLengthFactor);
                    if (this._shouldAttack) {
                        this.logger(`Globally switched to attack mode.`);
                    }
                } else {
                    // If currently attacking, make it harder to switch to defence mode my dampening the opponent's threat.
                    this._shouldAttack = this.checkShouldAttack(this.threatCache, 0.75 * gameLengthFactor);
                    if (!this._shouldAttack) {
                        this.logger(`Globally switched to defence mode.`);
                    }
                }
            }
        }

        // Update rally point every few ticks.
        if (game.getCurrentTick() % RALLY_POINT_UPDATE_INTERVAL_TICKS === 0) {
            const enemyPlayers = game
                .getPlayers()
                .filter((p) => p !== playerData.name && !game.areAlliedPlayers(playerData.name, p));
            const enemy = game.getPlayerData(enemyPlayers[0]);
            this.mainRallyPoint = getPointTowardsOtherPoint(
                game,
                playerData.startLocation,
                enemy.startLocation,
                10,
                10,
                0,
            );
        }
    }
}
