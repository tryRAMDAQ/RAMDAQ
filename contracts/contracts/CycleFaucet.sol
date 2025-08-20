// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CycleFaucet - testnet onboarding.
/// @notice Every visitor claims a one-time stack of CYCLE play-chips so they
/// can bet the race, buy agent shares and stake - no purchase, no barrier.
/// Testnet only; a faucet has no place on mainnet.
contract CycleFaucet is Ownable {
    IERC20 public immutable cycle;
    uint256 public claimAmount = 5_000 ether;
    mapping(address => bool) public claimed;

    event Claimed(address indexed who, uint256 amount);

    constructor(IERC20 _cycle) Ownable(msg.sender) {
        cycle = _cycle;
    }

    function claim() external {
        require(!claimed[msg.sender], "faucet: already claimed");
        claimed[msg.sender] = true;
        require(cycle.transfer(msg.sender, claimAmount), "faucet: dry - ping the team");
        emit Claimed(msg.sender, claimAmount);
    }

    function setClaimAmount(uint256 amount) external onlyOwner {
        claimAmount = amount;
    }

    function withdraw(uint256 amount) external onlyOwner {
        require(cycle.transfer(owner(), amount), "faucet: transfer failed");
    }
}
