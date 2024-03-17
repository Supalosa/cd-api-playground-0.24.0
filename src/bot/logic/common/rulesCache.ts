import { GameApi, ObjectType, TechnoRules } from "@chronodivide/game-api";

// checking technorules directly reduces the amount of calls to getUnitData(), which is a relatively expensive function.
// A null value indicates an object that does not have TechnoRules.
export const getTechnoRulesForUnit = (gameApi: GameApi, unitId: number): TechnoRules | null => {
    const gameObject = gameApi.getGameObjectData(unitId);
    if (!gameObject) {
        return null;
    }
    if (
        gameObject.type === ObjectType.Aircraft ||
        gameObject.type === ObjectType.Building ||
        gameObject.type === ObjectType.Infantry ||
        gameObject.type === ObjectType.Vehicle
    ) {
        return gameObject.rules as TechnoRules;
    }
    return null;
};
