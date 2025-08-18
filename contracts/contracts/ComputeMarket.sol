// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAgentRegistryMin, IStakingVaultMin} from "./Interfaces.sol";

/// @title ComputeMarket - the DePIN leg: raw compute, metered in CYCLE.
/// @notice GPU/CPU providers stake CYCLE and list capacity at a price per
/// unit-hour. Agents escrow rent for a slice, the provider confirms the
/// allocation, and on completion the provider is paid minus protocol fee.
/// Failed allocations refund the agent and slash the provider's stake - half
/// as compensation to the agent, half to the vault. Every agent action here
/// is real demand for raw compute capacity, priced on-chain.
///
/// In production this contract is the settlement layer over external DePIN
/// networks (Akash / io.net / Render adapters); the local demo runs a
/// simulated provider fleet against the exact same interface.
contract ComputeMarket is Ownable, ReentrancyGuard {
    enum RentalStatus {
        Requested, // escrowed, awaiting provider confirmation
        Active,    // provider confirmed, slice is live
        Completed, // settled, provider paid
        Failed,    // agent reported failure: refund + provider slash
        Cancelled  // agent withdrew before confirmation
    }

    struct Provider {
        uint64 id;
        address account;
        string name;
        string region;
        string gpuModel;
        uint32 totalUnits;
        uint32 availableUnits;
        uint256 pricePerUnitHour; // CYCLE (18d) per unit per hour
        uint256 stake;
        bool active;
        uint64 registeredAt;
        uint256 totalEarned;
        uint32 completedRentals;
        uint32 failedRentals;
    }

    struct Rental {
        uint64 id;
        uint64 providerId;
        uint64 agentId;
        uint32 units;
        uint32 durationSecs;
        uint64 requestedAt;
        uint64 startedAt;
        uint256 cost; // escrowed CYCLE
        RentalStatus status;
    }

    IERC20 public immutable cycle;
    IAgentRegistryMin public immutable registry;
    IStakingVaultMin public immutable vault;

    uint64 public providerCount;
    uint64 public rentalCount;
    mapping(uint64 => Provider) private _providers;
    mapping(uint64 => Rental) private _rentals;
    mapping(address => uint64) public accountToProviderId;

    uint256 public minProviderStake;
    uint16 public feeBps = 250;       // 2.5% of rent -> vault
    uint32 public confirmWindow = 60; // provider must confirm within this
    uint256 public totalComputeVolume;
    uint256 public totalFeesRouted;

    // ---- the AGORA Compute Index: volume-weighted price of a unit-hour ----
    uint256 public totalUnitSeconds; // units * seconds across settled rentals
    mapping(uint64 => uint256) public epochRentSpend;
    mapping(uint64 => uint256) public epochUnitSeconds;

    event ProviderRegistered(uint64 indexed providerId, address indexed account, string name, string gpuModel, uint32 units, uint256 pricePerUnitHour);
    event ProviderDeactivated(uint64 indexed providerId);
    event ProviderStakeWithdrawn(uint64 indexed providerId, uint256 amount);
    event RentalRequested(uint64 indexed rentalId, uint64 indexed providerId, uint64 indexed agentId, uint32 units, uint32 durationSecs, uint256 cost);
    event RentalConfirmed(uint64 indexed rentalId);
    event RentalCompleted(uint64 indexed rentalId, uint256 providerPay, uint256 fee);