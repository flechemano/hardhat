import type LodashCloneDeepT from "lodash.clonedeep";
import type {
  CompilerInput,
  DependencyGraph,
  CompilationJob,
} from "hardhat/types";
import type { VerifyTaskArgs } from "../..";
import type {
  LibraryToAddress,
  ExtendedContractInformation,
  ContractInformation,
} from "../solc/artifacts";

import { subtask, types } from "hardhat/config";
import {
  TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
  TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
} from "hardhat/builtin-tasks/task-names";
import { isFullyQualifiedName } from "hardhat/utils/contract-names";

import {
  CompilerVersionsMismatchError,
  ContractVerificationFailedError,
  MissingAddressError,
  InvalidAddressError,
  InvalidContractNameError,
  ContractNotFoundError,
  BuildInfoNotFoundError,
  BuildInfoCompilerVersionMismatchError,
  DeployedBytecodeMismatchError,
  UnexpectedNumberOfFilesError,
  VerificationAPIUnexpectedMessageError,
} from "../errors";
import { Etherscan } from "../etherscan";
import {
  extractMatchingContractInformation,
  extractInferredContractInformation,
  getLibraryInformation,
} from "../solc/artifacts";
import { Bytecode } from "../solc/bytecode";
import {
  TASK_VERIFY_ETHERSCAN,
  TASK_VERIFY_ETHERSCAN_RESOLVE_ARGUMENTS,
  TASK_VERIFY_ETHERSCAN_GET_CONTRACT_INFORMATION,
  TASK_VERIFY_ETHERSCAN_GET_MINIMAL_INPUT,
  TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION,
} from "../task-names";
import {
  getCompilerVersions,
  encodeArguments,
  resolveConstructorArguments,
  resolveLibraries,
  sleep,
} from "../utilities";

// parsed verification args
interface VerificationArgs {
  address: string;
  constructorArgs: string[];
  libraries: LibraryToAddress;
  contractFQN?: string;
}

interface GetContractInformationArgs {
  contractFQN?: string;
  deployedBytecode: Bytecode;
  matchingCompilerVersions: string[];
  libraries: LibraryToAddress;
}

interface GetMinimalInputArgs {
  sourceName: string;
}

interface AttemptVerificationArgs {
  address: string;
  compilerInput: CompilerInput;
  contractInformation: ExtendedContractInformation;
  verificationInterface: Etherscan;
  encodedConstructorArguments: string;
}

interface VerificationResponse {
  success: boolean;
  message: string;
}

/**
 * Main Etherscan verification subtask.
 *
 * Verifies a contract in Etherscan by coordinating various subtasks related
 * to contract verification.
 */
subtask(TASK_VERIFY_ETHERSCAN)
  .addParam("address")
  .addOptionalParam("constructorArgsParams", undefined, undefined, types.any)
  .addOptionalParam("constructorArgs")
  // TODO: [remove-verify-subtask] change to types.inputFile
  .addOptionalParam("libraries", undefined, undefined, types.any)
  .addOptionalParam("contract")
  .setAction(async (taskArgs: VerifyTaskArgs, { config, network, run }) => {
    const {
      address,
      constructorArgs,
      libraries,
      contractFQN,
    }: VerificationArgs = await run(
      TASK_VERIFY_ETHERSCAN_RESOLVE_ARGUMENTS,
      taskArgs
    );

    const chainConfig = await Etherscan.getCurrentChainConfig(
      network.name,
      network.provider,
      config.etherscan.customChains
    );

    const etherscan = Etherscan.fromChainConfig(
      config.etherscan.apiKey,
      chainConfig
    );

    const isVerified = await etherscan.isVerified(address);
    if (isVerified) {
      const contractURL = etherscan.getContractUrl(address);
      console.log(`The contract ${address} has already been verified.
${contractURL}`);
      return;
    }

    const configCompilerVersions = await getCompilerVersions(config.solidity);

    const deployedBytecode = await Bytecode.getDeployedContractBytecode(
      address,
      network.provider,
      network.name
    );

    const matchingCompilerVersions = await deployedBytecode.getMatchingVersions(
      configCompilerVersions
    );
    // don't error if the bytecode appears to be OVM bytecode, because we can't infer a specific OVM solc version from the bytecode
    if (matchingCompilerVersions.length === 0 && !deployedBytecode.isOvm()) {
      throw new CompilerVersionsMismatchError(
        configCompilerVersions,
        deployedBytecode.getVersion(),
        network.name
      );
    }

    const contractInformation: ExtendedContractInformation = await run(
      TASK_VERIFY_ETHERSCAN_GET_CONTRACT_INFORMATION,
      {
        contractFQN,
        deployedBytecode,
        matchingCompilerVersions,
        libraries,
      }
    );

    const minimalInput: CompilerInput = await run(
      TASK_VERIFY_ETHERSCAN_GET_MINIMAL_INPUT,
      {
        sourceName: contractInformation.sourceName,
      }
    );

    const encodedConstructorArguments = await encodeArguments(
      contractInformation.contractOutput.abi,
      contractInformation.sourceName,
      contractInformation.contractName,
      constructorArgs
    );

    // First, try to verify the contract using the minimal input
    const { success: minimalInputVerificationSuccess }: VerificationResponse =
      await run(TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION, {
        address,
        compilerInput: minimalInput,
        contractInformation,
        verificationInterface: etherscan,
        encodedConstructorArguments,
      });

    if (minimalInputVerificationSuccess) {
      return;
    }

    console.log(`We tried verifying your contract ${contractInformation.contractName} without including any unrelated one, but it failed.
Trying again with the full solc input used to compile and deploy it.
This means that unrelated contracts may be displayed on Etherscan...
`);

    // If verifying with the minimal input failed, try again with the full compiler input
    const {
      success: fullCompilerInputVerificationSuccess,
      message: verificationMessage,
    }: VerificationResponse = await run(
      TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION,
      {
        address,
        compilerInput: contractInformation.compilerInput,
        contractInformation,
        verificationInterface: etherscan,
        encodedConstructorArguments,
      }
    );

    if (fullCompilerInputVerificationSuccess) {
      return;
    }

    throw new ContractVerificationFailedError(
      verificationMessage,
      contractInformation.undetectableLibraries
    );
  });

subtask(TASK_VERIFY_ETHERSCAN_RESOLVE_ARGUMENTS)
  .addOptionalParam("address")
  .addOptionalParam("constructorArgsParams", undefined, [], types.any)
  .addOptionalParam("constructorArgs", undefined, undefined, types.inputFile)
  // TODO: [remove-verify-subtask] change to types.inputFile
  .addOptionalParam("libraries", undefined, undefined, types.any)
  .addOptionalParam("contract")
  .setAction(
    async ({
      address,
      constructorArgsParams,
      constructorArgs: constructorArgsModule,
      contract,
      libraries: librariesModule,
    }: VerifyTaskArgs): Promise<VerificationArgs> => {
      if (address === undefined) {
        throw new MissingAddressError();
      }

      const { isAddress } = await import("@ethersproject/address");
      if (!isAddress(address)) {
        throw new InvalidAddressError(address);
      }

      if (contract !== undefined && !isFullyQualifiedName(contract)) {
        throw new InvalidContractNameError(contract);
      }

      const constructorArgs = await resolveConstructorArguments(
        constructorArgsParams,
        constructorArgsModule
      );

      // TODO: [remove-verify-subtask] librariesModule should always be string
      let libraries;
      if (typeof librariesModule === "object") {
        libraries = librariesModule;
      } else {
        libraries = await resolveLibraries(librariesModule);
      }

      return {
        address,
        constructorArgs,
        libraries,
        contractFQN: contract,
      };
    }
  );

subtask(TASK_VERIFY_ETHERSCAN_GET_CONTRACT_INFORMATION)
  .addParam("deployedBytecode", undefined, undefined, types.any)
  .addParam("matchingCompilerVersions", undefined, undefined, types.any)
  .addParam("libraries", undefined, undefined, types.any)
  .addOptionalParam("contractFQN")
  .setAction(
    async (
      {
        contractFQN,
        deployedBytecode,
        matchingCompilerVersions,
        libraries,
      }: GetContractInformationArgs,
      { network, artifacts }
    ): Promise<ExtendedContractInformation> => {
      let contractInformation: ContractInformation | null;

      if (contractFQN !== undefined) {
        const artifactExists = await artifacts.artifactExists(contractFQN);

        if (!artifactExists) {
          throw new ContractNotFoundError(contractFQN);
        }

        const buildInfo = await artifacts.getBuildInfo(contractFQN);
        if (buildInfo === undefined) {
          throw new BuildInfoNotFoundError(contractFQN);
        }

        if (
          !matchingCompilerVersions.includes(buildInfo.solcVersion) &&
          !deployedBytecode.isOvm()
        ) {
          throw new BuildInfoCompilerVersionMismatchError(
            contractFQN,
            deployedBytecode.getVersion(),
            deployedBytecode.hasVersionRange(),
            buildInfo.solcVersion,
            network.name
          );
        }

        contractInformation = extractMatchingContractInformation(
          contractFQN,
          buildInfo,
          deployedBytecode
        );

        if (contractInformation === null) {
          throw new DeployedBytecodeMismatchError(network.name, contractFQN);
        }
      } else {
        contractInformation = await extractInferredContractInformation(
          artifacts,
          network,
          matchingCompilerVersions,
          deployedBytecode
        );
      }

      // map contractInformation libraries
      const libraryInformation = await getLibraryInformation(
        contractInformation,
        libraries
      );

      return {
        ...contractInformation,
        ...libraryInformation,
      };
    }
  );

subtask(TASK_VERIFY_ETHERSCAN_GET_MINIMAL_INPUT)
  .addParam("sourceName")
  .setAction(async ({ sourceName }: GetMinimalInputArgs, { run }) => {
    const cloneDeep = require("lodash.clonedeep") as typeof LodashCloneDeepT;
    const dependencyGraph: DependencyGraph = await run(
      TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
      { sourceNames: [sourceName] }
    );

    const resolvedFiles = dependencyGraph
      .getResolvedFiles()
      .filter((resolvedFile) => resolvedFile.sourceName === sourceName);

    if (resolvedFiles.length !== 1) {
      throw new UnexpectedNumberOfFilesError();
    }

    const compilationJob: CompilationJob = await run(
      TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
      {
        dependencyGraph,
        file: resolvedFiles[0],
      }
    );

    const minimalInput: CompilerInput = await run(
      TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
      {
        compilationJob,
      }
    );

    return cloneDeep(minimalInput);
  });

subtask(TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION)
  .addParam("address")
  .addParam("compilerInput", undefined, undefined, types.any)
  .addParam("contractInformation", undefined, undefined, types.any)
  .addParam("verificationInterface", undefined, undefined, types.any)
  .addParam("encodedConstructorArguments")
  .setAction(
    async ({
      address,
      compilerInput,
      contractInformation,
      verificationInterface,
      encodedConstructorArguments,
    }: AttemptVerificationArgs): Promise<VerificationResponse> => {
      // Ensure the linking information is present in the compiler input;
      compilerInput.settings.libraries = contractInformation.libraries;

      const { message: guid } = await verificationInterface.verify(
        address,
        JSON.stringify(compilerInput),
        `${contractInformation.sourceName}:${contractInformation.contractName}`,
        `v${contractInformation.solcLongVersion}`,
        encodedConstructorArguments
      );

      console.log(`Successfully submitted source code for contract
${contractInformation.sourceName}:${contractInformation.contractName} at ${address}
for verification on the block explorer. Waiting for verification result...
`);

      // Compilation is bound to take some time so there's no sense in requesting status immediately.
      await sleep(700);
      const verificationStatus =
        await verificationInterface.getVerificationStatus(guid);

      if (!(verificationStatus.isFailure() || verificationStatus.isSuccess())) {
        // Reaching this point shouldn't be possible unless the API is behaving in a new way.
        throw new VerificationAPIUnexpectedMessageError(
          verificationStatus.message
        );
      }

      if (verificationStatus.isSuccess()) {
        const contractURL = verificationInterface.getContractUrl(address);
        console.log(`Successfully verified contract ${contractInformation.contractName} on the block explorer.
${contractURL}\n`);
      }

      return {
        success: verificationStatus.isSuccess(),
        message: verificationStatus.message,
      };
    }
  );
