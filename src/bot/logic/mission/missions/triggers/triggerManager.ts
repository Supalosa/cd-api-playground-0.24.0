// State management for ai.ini TriggerTypes

import { GameApi, IniFile, PlayerData, ProductionApi, SideType } from "@chronodivide/game-api";
import { BotDifficulty } from "../../../../bot.js";
import {
    AiTriggerOwnerHouse,
    AiTriggerSideType,
    AiTriggerType,
    ComparatorOperator,
    ConditionType,
} from "./aiTriggerTypes.js";
import { DebugLogger, countBy, setDifference } from "../../../common/utils.js";
import { MissionController } from "../../missionController.js";
import { AiTeamType, loadTeamTypes } from "./aiTeamTypes.js";
import { AiTaskForce, loadTaskForces } from "./aiTaskForces.js";
import { generateTarget } from "../attackMission.js";
import { MatchAwareness } from "../../../awareness.js";
import { MissionFactory } from "../../missionFactories.js";
import { Mission } from "../../mission.js";
import { AiScriptType, loadScriptTypes } from "./scriptTypes.js";
import { ScriptedTeamMission } from "../scriptedTeamMission.js";

type AiTriggerCacheState = {
    enemyUnitCount: { [name: string]: number };
    ownUnitCount: { [name: string]: number };
    enemyCredits: number;
};

type ConditionEvaluator = (
    triggerCacheState: AiTriggerCacheState,
    comparisonObject: string,
    comparatorArgument: number,
    comparatorOperator: ComparatorOperator,
) => boolean;

const EVALUATOR_NOT_IMPLEMENTED = () => false;

const testOperator = (value: number, operator: ComparatorOperator, operand: number) => {
    switch (operator) {
        case ComparatorOperator.Equal:
            return value === operand;
        case ComparatorOperator.GreaterThan:
            return value > operand;
        case ComparatorOperator.GreaterThanOrEqual:
            return value >= operand;
        case ComparatorOperator.LessThan:
            return value < operand;
        case ComparatorOperator.LessThanOrEqual:
            return value <= operand;
        case ComparatorOperator.NotEqual:
            return value > operand;
    }
};

const enemyHouseOwns: ConditionEvaluator = (
    triggerCacheState,
    comparisonObject,
    comparatorArgument,
    comparatorOperator,
) => {
    return testOperator(
        triggerCacheState.enemyUnitCount[comparisonObject] ?? 0,
        comparatorOperator,
        comparatorArgument,
    );
};

const owningHouseOwns: ConditionEvaluator = (
    triggerCacheState,
    comparisonObject,
    comparatorArgument,
    comparatorOperator,
) => {
    return testOperator(triggerCacheState.ownUnitCount[comparisonObject] ?? 0, comparatorOperator, comparatorArgument);
};

const enemyHouseHasCredits: ConditionEvaluator = (
    triggerCacheState,
    comparisonObject,
    comparatorArgument,
    comparatorOperator,
) => {
    return testOperator(triggerCacheState.enemyCredits, comparatorOperator, comparatorArgument);
};

const conditionEvaluators: Map<ConditionType, ConditionEvaluator> = new Map([
    [ConditionType.AlwaysTrue, () => true],
    [ConditionType.EnemyHouseOwns, enemyHouseOwns],
    [ConditionType.OwningHouseOwns, owningHouseOwns],
    [ConditionType.EnemyHouseInYellowPower, EVALUATOR_NOT_IMPLEMENTED],
    [ConditionType.EnemyHouseInRedPower, EVALUATOR_NOT_IMPLEMENTED],
    [ConditionType.EnemyHouseHasCredits, enemyHouseHasCredits],
    [ConditionType.OwnerHasIronCurtainReady, EVALUATOR_NOT_IMPLEMENTED],
    [ConditionType.OwnerHasChronoSphereReady, EVALUATOR_NOT_IMPLEMENTED],
    [ConditionType.NeutralHouseOwns, EVALUATOR_NOT_IMPLEMENTED],
]);

export type ResolvedTeamType = Omit<AiTeamType, "taskForce" | "script"> & {
    taskForce: AiTaskForce;
    script: AiScriptType;
};

type ResolvedTriggerType = Omit<AiTriggerType, "teamType"> & {
    teamType: ResolvedTeamType;
};

export type GeneralAiRules = {
    dissolveUnfilledTeamDelay: number;
};

/**
 * The TriggeredAttackMissionFactory is a special type of MissionFactory that obeys the ai.ini triggers to create Attack Missions
 */
export class TriggeredAttackMissionFactory implements MissionFactory {
    private teamDelay: number;
    private triggerTypes = new Map<string, ResolvedTriggerType>();

    private teamCounts: { [teamName: string]: number } = {};

    private generalRules: GeneralAiRules;

    private lastTeamCheckAt = 0;
    private previousValidTriggers = new Set<string>();

    // TODO: this should come from the ini
    private teamLimit = 10;

    constructor(gameApi: GameApi, playerData: PlayerData, difficulty: BotDifficulty) {
        const { teamDelays, triggerTypes, dissolveUnfilledTeamDelay } = this.loadIni(
            gameApi.getRulesIni(),
            gameApi.getAiIni(),
            playerData,
            difficulty,
        );
        switch (difficulty) {
            case BotDifficulty.Easy:
                this.teamDelay = teamDelays[2];
                break;
            case BotDifficulty.Medium:
                this.teamDelay = teamDelays[1];
                break;
            case BotDifficulty.Hard:
            default:
                this.teamDelay = teamDelays[0];
                break;
        }
        this.triggerTypes = triggerTypes;
        this.generalRules = { dissolveUnfilledTeamDelay };
    }

    getName(): string {
        return "ai.ini trigger factory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        productionApi: ProductionApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        if (gameApi.getCurrentTick() > this.lastTeamCheckAt + this.teamDelay) {
            this.runTeamCheck(gameApi, productionApi, matchAwareness, playerData, missionController, logger);
            this.lastTeamCheckAt = gameApi.getCurrentTick();
        }
    }

    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission<any>,
        failureReason: any,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {}

    private loadIni(rulesIni: IniFile, aiIni: IniFile, playerData: PlayerData, difficulty: BotDifficulty) {
        const triggerTypes = new Map<string, ResolvedTriggerType>();
        const aiTriggerTypes = aiIni.getSection("AITriggerTypes");
        if (!aiTriggerTypes) {
            throw new Error("missing AITriggerTypes");
        }

        const aiTeamTypes = loadTeamTypes(aiIni);
        const aiTaskForces = loadTaskForces(aiIni);
        const aiScriptTypes = loadScriptTypes(aiIni, rulesIni);

        type ResolvedTeamTypes = { [name: string]: ResolvedTeamType };

        const resolvedTeamTypes: ResolvedTeamTypes = Object.entries(aiTeamTypes).reduce<ResolvedTeamTypes>((pV, cV) => {
            const [teamName, teamType] = cV;
            return Object.assign(pV, {
                [teamName]: {
                    ...teamType,
                    taskForce: aiTaskForces[teamType.taskForce],
                    script: aiScriptTypes[teamType.script],
                },
            });
        }, {});

        const histogram = new Map<number, number>();
        Object.values(resolvedTeamTypes).forEach((type) => {
            type.script.actions.forEach((action) => {
                histogram.set(action.action, (histogram.get(action.action) ?? 0) + 1);
            });
        });

        /*
        * Debug code, but possibly useful later?
        [...histogram.entries()].forEach(([k, v]) => {
            console.log(k, v);
        });
        */

        aiTriggerTypes.entries.forEach((value, id) => {
            const trigger = new AiTriggerType(id, value);
            // Don't store triggers that are not relevant to this agent.
            if (trigger.side === AiTriggerSideType.Soviet && playerData.country?.side !== SideType.Nod) {
                return;
            }
            if (trigger.side === AiTriggerSideType.Allied && playerData.country?.side !== SideType.GDI) {
                return;
            }
            if (
                trigger.ownerHouse === AiTriggerOwnerHouse.None ||
                (trigger.ownerHouse !== AiTriggerOwnerHouse.All && trigger.ownerHouse !== playerData.country?.name)
            ) {
                return;
            }
            if (!trigger.enabledInEasy && difficulty === BotDifficulty.Easy) {
                return;
            }
            if (!trigger.enabledInMedium && difficulty === BotDifficulty.Medium) {
                return;
            }
            if (!trigger.enabledInHard && difficulty === BotDifficulty.Hard) {
                return;
            }
            const resolvedTriggerType = {
                ...trigger,
                teamType: resolvedTeamTypes[trigger.teamType],
            };
            triggerTypes.set(id, resolvedTriggerType);
        });

        const teamDelays = rulesIni
            .getSection("General")
            ?.get("TeamDelays")
            ?.split(",")
            .map((s) => parseInt(s));
        if (!teamDelays) {
            throw new Error("missing TeamDelays");
        }

        const dissolveUnfilledTeamDelay = parseInt(
            rulesIni.getSection("General")?.get("DissolveUnfilledTeamDelay") ?? "",
        );
        if (!dissolveUnfilledTeamDelay) {
            throw new Error("missing DissolveUnfilledTeamDelay");
        }
        return { triggerTypes, teamDelays, dissolveUnfilledTeamDelay };
    }

    public runTeamCheck(
        game: GameApi,
        production: ProductionApi,
        matchAwareness: MatchAwareness,
        myPlayer: PlayerData,
        missionController: MissionController,
        logger: DebugLogger,
    ) {
        if (missionController.getMissions().length >= this.teamLimit) {
            // TODO: maybe this should be based on teams created by the trigger manager, not other missions
            return;
        }
        // Calculate expensive things only once before all triggers.
        // We only add the targeted player to the cache, otherwise we get weird situations like triggering "vs Ally" missions against Soviets in 2v2 games.
        const targetedPlayer = matchAwareness.getTargetedPlayer();
        const enemyUnits = targetedPlayer ? game.getVisibleUnits(targetedPlayer, "self") : [];
        const ownUnits = game.getVisibleUnits(myPlayer.name, "self");

        const enemyCredits = game
            .getPlayers()
            .filter((name) => !game.areAlliedPlayers(myPlayer.name, name))
            .map((name) => game.getPlayerData(name).credits)
            .reduce((p, v) => p + v, 0);

        const triggerCacheState: AiTriggerCacheState = {
            enemyUnitCount: countBy(enemyUnits, (id) => game.getGameObjectData(id)?.name),
            ownUnitCount: countBy(ownUnits, (id) => game.getGameObjectData(id)?.name),
            enemyCredits,
        };

        // Only allow triggers to be chosen if we can actually produce them
        const producableUnits = new Set(production.getAvailableObjects().map((r) => r.name));

        const firingTriggers = [...this.triggerTypes.values()].filter((trigger) => {
            // only pick triggers for which we can actually produce the units
            if (trigger.teamType.taskForce) {
                const taskForceUnits = trigger.teamType.taskForce.units;
                if (Object.keys(taskForceUnits).some((unitName) => !producableUnits.has(unitName))) {
                    return false;
                }
                // respect max team count
                const currentTeamCount = this.getTeamCount(trigger.teamType.name);
                if (currentTeamCount >= trigger.teamType.max) {
                    return false;
                }
            }

            const conditionEvaluator = conditionEvaluators.get(trigger.conditionType);
            if (!conditionEvaluator) {
                throw new Error(`Missing condition evaluator ${trigger.conditionType} for ${trigger}`);
            }
            const { comparisonObject, comparatorArgument, comparatorOperator } = trigger;
            return conditionEvaluator(triggerCacheState, comparisonObject, comparatorArgument, comparatorOperator);
        });
        const newTriggerSet = new Set(firingTriggers.map(({ name }) => name));

        const diff = setDifference(this.previousValidTriggers, newTriggerSet);
        if (diff.length > 0) {
            logger("Mission trigger state change:" + diff);
        }
        this.previousValidTriggers = newTriggerSet;

        if (firingTriggers.length === 0) {
            return;
        }

        // TODO: implementing changing weights.
        const chosenMission = this.weightedRandom(
            game,
            firingTriggers.map((trigger) => ({ item: trigger, weight: trigger.startingWeight })),
        );

        if (!chosenMission) {
            return;
        }
        logger(`Chose mission: ${chosenMission.name}`);
        // TODO: implement attack target from script.
        const attackTarget = generateTarget(game, myPlayer, matchAwareness, true);
        if (!attackTarget) {
            return;
        }
        const mission = new ScriptedTeamMission(
            `aiTriggerMission_${chosenMission.name}_${game.getCurrentTick()}`,
            chosenMission.teamType,
            this.generalRules,
            logger,
        );
        const newMission = missionController.addMission(mission);

        if (newMission) {
            const newCount = this.incrementTeamCount(chosenMission.teamType.name);
            logger(
                `Mission ${mission.getUniqueName()} has started, total count of team ${
                    chosenMission.teamType.name
                } = ${newCount}`,
            );
            newMission.then(() => {
                const newCount = this.decrementTeamCount(chosenMission.teamType.name);
                logger(
                    `Mission ${mission.getUniqueName()} has ended, total count of team ${
                        chosenMission.teamType.name
                    } = ${newCount}`,
                );
            });
        }
    }

    private getTeamCount(teamName: string) {
        return this.teamCounts[teamName] ?? 0;
    }

    private incrementTeamCount(teamName: string) {
        this.teamCounts[teamName] = (this.teamCounts[teamName] ?? 0) + 1;
        return this.teamCounts[teamName];
    }

    private decrementTeamCount(teamName: string) {
        this.teamCounts[teamName] = (this.teamCounts[teamName] ?? 0) - 1;
        return this.teamCounts[teamName];
    }

    // https://stackoverflow.com/a/55671924
    private weightedRandom<T>(gameApi: GameApi, items: { item: T; weight: number }[]) {
        const adjWeights = items.map((item) => item.weight);

        for (let i = 1; i < items.length; i++) {
            adjWeights[i] += adjWeights[i - 1];
        }

        const random = gameApi.generateRandom() * adjWeights[adjWeights.length - 1];

        for (let i = 0; i < items.length; i++) {
            if (adjWeights[i] > random) {
                return items[i].item;
            }
        }

        return null;
    }
}
