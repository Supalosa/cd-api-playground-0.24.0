import {
    GameApi,
    GameMath,
    GameObjectData,
    MovementZone,
    ObjectType,
    PlayerData,
    ProjectileRules,
    WeaponRules,
} from "@chronodivide/game-api";
import { GlobalThreat } from "./threat.js";
import { getTechnoRulesForUnit } from "../common/rulesCache.js";
import { groupBy } from "../common/utils.js";

export function calculateGlobalThreat(game: GameApi, playerData: PlayerData, visibleAreaPercent: number): GlobalThreat {
    let groundUnits = game.getVisibleUnits(
        playerData.name,
        "enemy",
        (r) => r.type == ObjectType.Vehicle || r.type == ObjectType.Infantry,
    );
    let airUnits = game.getVisibleUnits(playerData.name, "enemy", (r) => r.movementZone == MovementZone.Fly);
    let groundDefence = game
        .getVisibleUnits(playerData.name, "enemy", (r) => r.type == ObjectType.Building)
        .filter((unitId) => isAntiGround(game, unitId));
    let antiAirPower = game
        .getVisibleUnits(playerData.name, "enemy", (r) => r.type != ObjectType.Building)
        .filter((unitId) => isAntiAir(game, unitId));

    let ourAntiGroundUnits = game
        .getVisibleUnits(playerData.name, "self", (r) => r.isSelectableCombatant)
        .filter((unitId) => isAntiGround(game, unitId));
    let ourAntiAirUnits = game
        .getVisibleUnits(playerData.name, "self", (r) => r.isSelectableCombatant || r.type === ObjectType.Building)
        .filter((unitId) => isAntiAir(game, unitId));
    let ourGroundDefence = game
        .getVisibleUnits(playerData.name, "self", (r) => r.type === ObjectType.Building)
        .filter((unitId) => isAntiGround(game, unitId));
    let ourAirUnits = game.getVisibleUnits(
        playerData.name,
        "self",
        (r) => r.movementZone == MovementZone.Fly && r.isSelectableCombatant,
    );

    let observedGroundThreat = calculateFirepowerForUnitIds(game, groundUnits);
    let observedAirThreat = calculateFirepowerForUnitIds(game, airUnits);
    let observedAntiAirThreat = calculateFirepowerForUnitIds(game, antiAirPower);
    let observedGroundDefence = calculateFirepowerForUnitIds(game, groundDefence);

    let ourAntiGroundPower = calculateFirepowerForUnitIds(game, ourAntiGroundUnits);
    let ourAntiAirPower = calculateFirepowerForUnitIds(game, ourAntiAirUnits);
    let ourAirPower = calculateFirepowerForUnitIds(game, ourAirUnits);
    let ourGroundDefencePower = calculateFirepowerForUnitIds(game, ourGroundDefence);

    // Create a map of player names to their total threat (that we can see).
    const totalThreatPerPlayer: { [name: string]: number } = {};
    const allPlayers = game.getPlayers();
    for (const player of allPlayers) {
        const playerUnits = game.getVisibleUnits(player, "self");
        totalThreatPerPlayer[player] = calculateFirepowerForUnitIds(game, playerUnits);
    }

    return new GlobalThreat(
        visibleAreaPercent,
        observedGroundThreat,
        observedAirThreat,
        observedAntiAirThreat,
        observedGroundDefence,
        ourGroundDefencePower,
        ourAntiGroundPower,
        ourAntiAirPower,
        ourAirPower,
        totalThreatPerPlayer,
    );
}

// For the purposes of determining if units can target air/ground, we look purely at the technorules and only the base weapon (not elite)
// This excludes some special cases such as IFVs changing turrets, but we have to deal with it for now.
function isAntiGround(gameApi: GameApi, unitId: number): boolean {
    return testProjectile(gameApi, unitId, (p) => p.isAntiGround);
}
function isAntiAir(gameApi: GameApi, unitId: number): boolean {
    return testProjectile(gameApi, unitId, (p) => p.isAntiAir);
}

function testProjectile(gameApi: GameApi, unitId: number, test: (p: ProjectileRules) => boolean) {
    const rules = getTechnoRulesForUnit(gameApi, unitId);
    if (!rules || !(rules.primary || rules.secondary)) {
        return false;
    }

    const primaryWeapon = rules.primary ? gameApi.rulesApi.getWeapon(rules.primary) : null;
    const primaryProjectile = getProjectileRules(gameApi, primaryWeapon);
    if (primaryProjectile && test(primaryProjectile)) {
        return true;
    }

    const secondaryWeapon = rules.secondary ? gameApi.rulesApi.getWeapon(rules.secondary) : null;
    const secondaryProjectile = getProjectileRules(gameApi, secondaryWeapon);
    if (secondaryProjectile && test(secondaryProjectile)) {
        return true;
    }

    return false;
}

function getProjectileRules(gameApi: GameApi, weapon: WeaponRules | null): ProjectileRules | null {
    const primaryProjectile = weapon ? gameApi.rulesApi.getProjectile(weapon.projectile) : null;
    return primaryProjectile;
}

function calculateFirepowerForUnit(gameApi: GameApi, gameObjectData: GameObjectData): number {
    const rules = getTechnoRulesForUnit(gameApi, gameObjectData.id);
    if (!rules) {
        return 0;
    }
    const currentHp = gameObjectData?.hitPoints || 0;
    const maxHp = gameObjectData?.maxHitPoints || 0;
    let threat = 0;
    const hpRatio = currentHp / Math.max(1, maxHp);

    if (rules.primary) {
        const weapon = gameApi.rulesApi.getWeapon(rules.primary);
        threat += (hpRatio * ((weapon.damage + 1) * GameMath.sqrt(weapon.range + 1))) / Math.max(weapon.rof, 1);
    }
    if (rules.secondary) {
        const weapon = gameApi.rulesApi.getWeapon(rules.secondary);
        threat += (hpRatio * ((weapon.damage + 1) * GameMath.sqrt(weapon.range + 1))) / Math.max(weapon.rof, 1);
    }
    // clamp the threat at 800, as we don't want to overestimate the threat of a single unit.
    return Math.min(800, threat);
}

function calculateFirepowerForUnitIds(game: GameApi, unitIds: number[]) {
    return calculateFirepowerForGameObjects(
        game,
        unitIds.map((unitId) => game.getGameObjectData(unitId)).filter((x): x is GameObjectData => !!x),
    );
}

function calculateFirepowerForGameObjects(game: GameApi, gameObjects: GameObjectData[]) {
    return gameObjects.reduce((pV, gO) => pV + calculateFirepowerForUnit(game, gO), 0);
}
