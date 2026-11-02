import { MemoryRepository } from "../../src/adapters/memory-repository";
import { repositoryContract } from "../helpers/repo-contract";

repositoryContract("MemoryRepository", async () => new MemoryRepository());
