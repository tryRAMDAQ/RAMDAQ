// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILockerFees {
    function claim(address currency) external returns (uint256);
    function claimable(address recipient, address currency) external view returns (uint256);
}

/// @title ProtocolFeeSplitter
/// @notice Sits as the LaunchLocker's `protocolFeeRecipient` and splits the protocol's
/// share of launch-pool trading fees:
///
/// - The Flywheel's cut is PUSH-based: `sweep` is permissionless, so anyone (the daily
///   keeper included) can forward it — buy-and-burn stays autonomous, no human required.
/// - The treasury's cut is PULL-based: it accrues inside this contract and only the
///   treasury wallet itself can withdraw, whenever it chooses — mirroring how creator
///   fees work in the locker.
///
/// With the locker's creator share at 60%, a 7500 bps treasury cut here yields the
/// platform split: 60% creator (claim) · 30% treasury (claim) · 10% flywheel (auto).
///
/// Deliberately ownerless and immutable: no admin can redirect the flow after deploy.
contract ProtocolFeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    ILockerFees public immutable locker;
    address public immutable treasury;
    address public immutable flywheel;