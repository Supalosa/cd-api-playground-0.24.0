// Interpreter for ai.ini TriggerTypes

import { FactoryType, IniFile, IniSection, ObjectType, TechnoRules } from "@chronodivide/game-api";
import { scryptSync } from "crypto";
import { Script } from "vm";

export const loadScriptTypes = (aiIni: IniFile, rulesIni: IniFile): { [id: string]: AiScriptType } => {
    const scriptTypesIndex = aiIni.getSection("ScriptTypes");
    if (!scriptTypesIndex) {
        throw new Error("Missing ScriptTypes in ai.ini");
    }
    const buildingTypesSection = rulesIni.getSection("BuildingTypes");
    if (!buildingTypesSection) {
        throw new Error(`Missing BuildingTypes in rules.ini`);
    }
    const scriptTypes: { [id: string]: AiScriptType } = {};

    scriptTypesIndex.entries.forEach((scriptTypeId, key) => {
        const section = aiIni.getSection(scriptTypeId);
        if (!section) {
            throw new Error(`Missing ScriptType ${scriptTypeId} in ai.ini`);
        }
        scriptTypes[scriptTypeId] = new AiScriptType(scriptTypeId, section, buildingTypesSection);
    });

    return scriptTypes;
};

const MAX_SCRIPT_TYPE_COUNT = 50;

export enum ScriptTypeAction {
    AttackQuarryType = 0,
    AttackWaypoint = 1,
    DoNothing = 2,
    MoveToWaypoint = 3,
    MoveIntoSpecificCell = 4,
    GuardArea = 5,
    JumpToLine = 6,
    ForcePlayerWin = 7,
    Unload = 8,
    Deploy = 9,
    FollowFriendlies = 10,
    AssignNewMission = 11,
    SetGlobalVariable = 12,
    PlayIdleAnimSequence = 13,
    LoadOntoTransport = 14,
    SpyOnStructureAtWaypoint = 15,
    PatrolToWaypoint = 16,
    ChangeScript = 17,
    ChangeTeam = 18,
    Panic = 19,
    ChangeHouseOwnership = 20,
    Scatter = 21,
    AfraidAndRunToShroud = 22,
    ForcePlayerLoss = 23,
    PlaySpeech = 24,
    PlaySound = 25,
    PlayMovie = 26,
    PlayTheme = 27,
    ReduceTiberiumOre = 28,
    BeginProduction = 29,
    ForceSale = 30,
    Suicide = 31,
    StartStormIn = 32,
    EndStorm = 33,
    CenterMapOnTeam = 34,
    ShroudMapForTimeInterval = 35,
    RevealMapForTimeInterval = 36,
    DeleteTeamMembers = 37,
    ClearGlobalVariable = 38,
    SetLocalVariable = 39,
    ClearLocalVariable = 40,
    Unpanic = 41,
    ChangeFacing = 42,
    WaitUntilFullyLoaded = 43,
    UnloadTruck = 44,
    LoadTruck = 45,
    AttackEnemyStructure = 46,
    MoveToEnemyStructure = 47,
    Scout = 48,
    RegisterSuccess = 49,
    Flash = 50,
    PlayAnimation = 51,
    DisplayTalkBubble = 52,
    GatherAtEnemyBase = 53,
    RegroupAtFriendlyBase = 54,
    ActivateIronCurtainOnTaskForce = 55,
    ChronoshiftTaskForceToBuilding = 56,
    ChronoshiftTaskForceToTargetType = 57,
    MoveToFriendlyStructure = 58,
    AttackStructureAtWaypoint = 59,
    EnterGrinder = 60,
    OccupyTankBunker = 61,
    EnterBioReactor = 62,
    OccupyBattleBunker = 63,
    GarrisonStructure = 64,
}

export type ScriptTypeActionData = {
    name: string;
    argumentType?: string;
};

export enum QuarryType {
    None = 0,
    Anything = 1,
    Structures = 2,
    Harvesters = 3,
    Infantry = 4,
    Vehicles = 5,
    Factories = 6,
    BaseDefences = 7,
    BaseThreats = 8,
    PowerPlants = 9,
    Occupiable = 10,
    TechBuildings = 11,
}

export type QuarryTypeFilter = (rules: TechnoRules) => boolean;

export const QUARRY_TYPES = new Map<QuarryType, QuarryTypeFilter>([
    [QuarryType.None, () => false],
    [QuarryType.Anything, () => true],
    [QuarryType.Structures, (rules) => rules.type === ObjectType.Building],
    [QuarryType.Harvesters, (rules) => rules.harvester],
    [QuarryType.Infantry, (rules) => rules.type === ObjectType.Infantry],
    [QuarryType.Vehicles, (rules) => rules.type === ObjectType.Vehicle],
    [QuarryType.Factories, (rules) => rules.factory !== FactoryType.None],
    [QuarryType.BaseDefences, (rules) => rules.isBaseDefense],
    [QuarryType.BaseThreats, (rules) => false], // TODO: Implement
    [QuarryType.PowerPlants, (rules) => rules.power > 0],
    [QuarryType.Occupiable, (rules) => rules.canBeOccupied],
    [QuarryType.TechBuildings, (rules) => rules.needsEngineer],
]);

// Only listing script types that are used in the default ini.
export const SCRIPT_TYPE_ACTIONS = new Map<ScriptTypeAction, ScriptTypeActionData>([
    [ScriptTypeAction.AttackQuarryType, { name: "AttackQuarryType", argumentType: "QuarryType" }],
    [ScriptTypeAction.GuardArea, { name: "GuardArea", argumentType: "Time" }],
    [ScriptTypeAction.JumpToLine, { name: "JumpToLine", argumentType: "Line" }],
    [ScriptTypeAction.Unload, { name: "Unload", argumentType: "UnloadBehaviour" }],
    [ScriptTypeAction.AssignNewMission, { name: "AssignNewMission", argumentType: "Mission" }],
    [ScriptTypeAction.LoadOntoTransport, { name: "LoadOntoTransport" }],
    [ScriptTypeAction.Scatter, { name: "Scatter", argumentType: "Time" }],
    [ScriptTypeAction.WaitUntilFullyLoaded, { name: "WaitUntilFullyLoaded" }],
    [ScriptTypeAction.AttackEnemyStructure, { name: "AttackEnemyStructure", argumentType: "BuildingWithProperty" }],
    [ScriptTypeAction.MoveToEnemyStructure, { name: "MoveToEnemyStructure", argumentType: "BuildingWithProperty" }],
    [ScriptTypeAction.RegisterSuccess, { name: "RegisterSuccess" }],
    [ScriptTypeAction.GatherAtEnemyBase, { name: "GatherAtEnemyBase" }],
    [ScriptTypeAction.RegroupAtFriendlyBase, { name: "RegroupAtFriendlyBase" }],
    [ScriptTypeAction.ActivateIronCurtainOnTaskForce, { name: "ActivateIronCurtainOnTaskForce" }],
    [
        ScriptTypeAction.ChronoshiftTaskForceToTargetType,
        { name: "ChronoshiftTaskForceToTargetType", argumentType: "QuarryType" },
    ],
    [
        ScriptTypeAction.MoveToFriendlyStructure,
        { name: "MoveToFriendlyStructure", argumentType: "BuildingWithProperty" },
    ],
]);

/**
 * Which scripts are actually used in the default ini?
 * 
   0 219 -> AttackQuarryType
   5 16 -> GuardArea
   6 3 -> JumpToLine
   8 12 -> Unload
   11 15 -> AssignNewMission
   14 13 -> LoadOntoTransport
   21 1 -> Scatter
   43 13 -> WaitUntilFullyLoaded
   46 35 -> AttackEnemyStructure
   47 27 -> MoveToEnemyStructure
   49 65 -> RegisterSuccess
   53 42 -> GatherAtEnemyBase
   54 41 -> RegroupAtFriendlyBase
   55 7 -> ActivateIronCurtainOnTaskForce
   57 2 -> ChronoshiftTaskForceToTargetType
   58 38 -> MoveToFriendlyStructure
 */

export type AttackQuarryTypeStep = {
    action: ScriptTypeAction.AttackQuarryType;
    quarryType: QuarryType;
};

export type GuardAreaStep = {
    action: ScriptTypeAction.GuardArea;
    time: number;
};

export type JumpToLineStep = {
    action: ScriptTypeAction.JumpToLine;
    line: number;
};

export enum AssignableMissions {
    NotImplemented = -1,
    // In default ai.ini, this is the only one that is used.
    AreaGuard = 11,
}

export type AssignNewMissionStep = {
    action: ScriptTypeAction.AssignNewMission;
    mission: AssignableMissions;
};

export type AttackEnemyStructureStep = _BuildingWithPropertyStep<ScriptTypeAction.AttackEnemyStructure>;

export type MoveToEnemyStructureStep = _BuildingWithPropertyStep<ScriptTypeAction.MoveToEnemyStructure>;

export type MoveToFriendlyStructureStep = _BuildingWithPropertyStep<ScriptTypeAction.MoveToFriendlyStructure>;

export type DefaultScriptStep = {
    action: ScriptTypeAction;
    argument: number;
};

export type ResolvedScriptTypeEntry =
    | AttackQuarryTypeStep
    | GuardAreaStep
    | JumpToLineStep
    | AssignNewMissionStep
    | AttackEnemyStructureStep
    | MoveToEnemyStructureStep
    | MoveToFriendlyStructureStep
    | DefaultScriptStep;

export type BuildingWithPropertyArguments = {
    buildingType: string;
    selectionMode: BuildingWithPropertySelectionMode;
};

type _BuildingWithPropertyStep<T extends ScriptTypeAction> = {
    action: T;
} & BuildingWithPropertyArguments;

function resolveBuildingWithProperty<T extends ScriptTypeAction>(
    action: T,
    argument: number,
    buildingTypes: string[],
): _BuildingWithPropertyStep<T> {
    return {
        action,
        buildingType: buildingTypes[argument & 0x0000ff],
        selectionMode: (argument & 0xff0000) >> 16,
    };
}

export enum BuildingWithPropertySelectionMode {
    LeastThreat,
    HighestThreat,
    Nearest,
    Farthest,
}

function resolveAction(
    { action, argument }: { action: ScriptTypeAction; argument: number },
    buildingTypes: string[],
): ResolvedScriptTypeEntry {
    switch (action) {
        case ScriptTypeAction.AttackQuarryType:
            return { action, quarryType: argument };
        case ScriptTypeAction.GuardArea:
            return { action, time: argument };
        case ScriptTypeAction.JumpToLine:
            return { action, line: argument };
        case ScriptTypeAction.AssignNewMission:
            return { action, mission: argument };
        case ScriptTypeAction.AttackEnemyStructure:
            return resolveBuildingWithProperty(action, argument, buildingTypes);
        case ScriptTypeAction.MoveToEnemyStructure:
            return resolveBuildingWithProperty(action, argument, buildingTypes);
        case ScriptTypeAction.MoveToFriendlyStructure:
            return resolveBuildingWithProperty(action, argument, buildingTypes);
        default:
            return { action, argument };
    }
}

// https://modenc.renegadeprojects.com/TaskForces
export class AiScriptType {
    public readonly name: string;
    public readonly actions: ResolvedScriptTypeEntry[] = [];

    constructor(
        public readonly id: string,
        iniSection: IniSection,
        buildingTypesSection: IniSection,
    ) {
        // it is assumed that iniSection is genuinely a TeamType, and not some other key.
        this.name = iniSection.getString("Name");

        const high = buildingTypesSection.getHighestNumericIndex();
        const buildingTypes: string[] = new Array(high);
        buildingTypesSection.entries.forEach((value, key) => {
            // We subtract one, because the references in the script types are actually zero-based (but the keys are 1-based)
            const index = parseInt(key) - 1;
            buildingTypes[index] = value;
        });

        for (let i = 0; i < MAX_SCRIPT_TYPE_COUNT; ++i) {
            if (!iniSection.has(i.toString())) {
                break;
            }
            const text = iniSection.getString(i.toString());
            const [action, argument] = text.split(",");
            const rawAction = { action: parseInt(action), argument: parseInt(argument) };
            this.actions.push(resolveAction(rawAction, buildingTypes));
        }
    }
}
