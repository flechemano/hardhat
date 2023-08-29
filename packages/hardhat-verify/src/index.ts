import type { LibraryToAddress } from "./internal/solc/artifacts";

import chalk from "chalk";
import { extendConfig, subtask, task, types } from "hardhat/config";
import {
  TASK_VERIFY,
  TASK_VERIFY_GET_VERIFICATION_SUBTASKS,
  TASK_VERIFY_VERIFY,
  TASK_VERIFY_ETHERSCAN,
  TASK_VERIFY_PRINT_SUPPORTED_NETWORKS,
  TASK_VERIFY_SOURCIFY,
  TASK_VERIFY_SOURCIFY_DISABLED_WARNING,
} from "./internal/task-names";
import {
  etherscanConfigExtender,
  sourcifyConfigExtender,
} from "./internal/config";
import {
  InvalidConstructorArgumentsError,
  InvalidLibrariesError,
  HardhatVerifyError,
} from "./internal/errors";
import {
  printSupportedNetworks,
  printVerificationErrors,
} from "./internal/utilities";

import "./internal/type-extensions";
import "./internal/tasks/etherscan";
import "./internal/tasks/sourcify";

// Main task args
export interface VerifyTaskArgs {
  address?: string;
  constructorArgsParams: string[];
  constructorArgs?: string;
  libraries?: string;
  contract?: string;
  listNetworks: boolean;
}

// verify:verify subtask args
interface VerifySubtaskArgs {
  address?: string;
  constructorArguments: string[];
  libraries: LibraryToAddress;
  contract?: string;
}

extendConfig(etherscanConfigExtender);
extendConfig(sourcifyConfigExtender);

/**
 * Main verification task.
 *
 * This is a meta-task that gets all the verification tasks and runs them.
 * Right now there's only a "verify-etherscan" task.
 */
task(TASK_VERIFY, "Verifies a contract on Etherscan")
  .addOptionalPositionalParam("address", "Address of the contract to verify")
  .addOptionalVariadicPositionalParam(
    "constructorArgsParams",
    "Contract constructor arguments. Cannot be used if the --constructor-args option is provided",
    []
  )
  .addOptionalParam(
    "constructorArgs",
    "Path to a Javascript module that exports the constructor arguments",
    undefined,
    types.inputFile
  )
  .addOptionalParam(
    "libraries",
    "Path to a Javascript module that exports a dictionary of library addresses. " +
      "Use if there are undetectable library addresses in your contract. " +
      "Library addresses are undetectable if they are only used in the contract constructor",
    undefined,
    types.inputFile
  )
  .addOptionalParam(
    "contract",
    "Fully qualified name of the contract to verify. Skips automatic detection of the contract. " +
      "Use if the deployed bytecode matches more than one contract in your project"
  )
  .addFlag("listNetworks", "Print the list of supported networks")
  .setAction(async (taskArgs: VerifyTaskArgs, { run }) => {
    if (taskArgs.listNetworks) {
      await run(TASK_VERIFY_PRINT_SUPPORTED_NETWORKS);
      return;
    }

    const verificationSubtasks: string[] = await run(
      TASK_VERIFY_GET_VERIFICATION_SUBTASKS
    );

    const errors: Record<string, HardhatVerifyError> = {};
    let hasErrors = false;
    for (const verificationSubtask of verificationSubtasks) {
      try {
        await run(verificationSubtask, taskArgs);
      } catch (error) {
        hasErrors = true;
        errors[verificationSubtask] = error as HardhatVerifyError;
      }
    }

    if (hasErrors) {
      printVerificationErrors(errors);
      process.exit(1);
    }
  });

subtask(
  TASK_VERIFY_PRINT_SUPPORTED_NETWORKS,
  "Prints the supported networks list"
).setAction(async ({}, { config }) => {
  await printSupportedNetworks(config.etherscan.customChains);
});

subtask(
  TASK_VERIFY_GET_VERIFICATION_SUBTASKS,
  async (_, { config, userConfig }): Promise<string[]> => {
    const verificationSubtasks = [];

    if (config.etherscan.enabled) {
      verificationSubtasks.push(TASK_VERIFY_ETHERSCAN);
    }

    if (config.sourcify.enabled) {
      verificationSubtasks.push(TASK_VERIFY_SOURCIFY);
    } else if (
      userConfig.sourcify?.enabled === undefined ||
      userConfig.sourcify?.enabled === false
    ) {
      verificationSubtasks.push(TASK_VERIFY_SOURCIFY_DISABLED_WARNING);
    }

    if (!config.etherscan.enabled && !config.sourcify.enabled) {
      console.warn(
        chalk.yellow(
          `WARNING: No verification services are enabled. Please enable at least one verification service in your configuration.`
        )
      );
    }

    return verificationSubtasks;
  }
);

/**
 * This subtask is used for backwards compatibility.
 * TODO [remove-verify-subtask]: if you're going to remove this subtask,
 * update TASK_VERIFY_ETHERSCAN and TASK_VERIFY_ETHERSCAN_RESOLVE_ARGUMENTS accordingly
 */
subtask(TASK_VERIFY_VERIFY)
  .addOptionalParam("address")
  .addOptionalParam("constructorArguments", undefined, [], types.any)
  .addOptionalParam("libraries", undefined, {}, types.any)
  .addOptionalParam("contract")
  .setAction(
    async (
      { address, constructorArguments, libraries, contract }: VerifySubtaskArgs,
      { run }
    ) => {
      // This can only happen if the subtask is invoked from within Hardhat by a user script or another task.
      if (!Array.isArray(constructorArguments)) {
        throw new InvalidConstructorArgumentsError();
      }

      if (typeof libraries !== "object" || Array.isArray(libraries)) {
        throw new InvalidLibrariesError();
      }

      await run(TASK_VERIFY_ETHERSCAN, {
        address,
        constructorArgsParams: constructorArguments,
        libraries,
        contract,
      });
    }
  );
