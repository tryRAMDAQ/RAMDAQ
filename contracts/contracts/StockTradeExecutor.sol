// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20StockTrade {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPermit2StockTrade {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouterStockTrade {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Executes an exact-amount USDG -> NVDA Robinhood Stock Token purchase.
/// @dev The explicit method and event make the purchase legible on explorers,
///      while the canonical ERC-20 transfer remains the source of truth.
contract StockTradeExecutor {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    address public constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address public constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    uint24 public constant POOL_FEE = 3000;
    int24 public constant TICK_SPACING = 60;

    bool private entered;

    event StockPurchased(
        address indexed buyer,
        string symbol,
        address indexed stockToken,
        uint256 usdgSpent,
        uint256 stockTokensReceived
    );

    error ReentrantCall();
    error InvalidAmount();
    error DeadlineExpired();
    error TokenCallFailed();
    error InsufficientOutput(uint256 received, uint256 minimum);

    constructor() {
        _safeApprove(USDG, PERMIT2, type(uint256).max);
        IPermit2StockTrade(PERMIT2).approve(
            USDG,
            UNIVERSAL_ROUTER,
            type(uint160).max,
            type(uint48).max
        );
    }

    /// @notice Buy canonical NVDA Robinhood Stock Tokens with an exact USDG amount.
    /// @param usdgIn Exact USDG to spend (USDG has 6 decimals).
    /// @param minNvdaOut Minimum NVDA tokens accepted (NVDA has 18 decimals).
    /// @param deadline Unix timestamp after which the purchase must revert.
    function buyStock(
        uint256 usdgIn,
        uint256 minNvdaOut,
        uint256 deadline
    ) external returns (uint256 received) {
        if (entered) revert ReentrantCall();
        if (usdgIn == 0 || usdgIn > type(uint128).max || minNvdaOut > type(uint128).max) {
            revert InvalidAmount();
        }
        if (block.timestamp > deadline) revert DeadlineExpired();
        entered = true;

        _safeTransferFrom(USDG, msg.sender, address(this), usdgIn);
        uint256 beforeBalance = IERC20StockTrade(NVDA).balanceOf(address(this));

        PathKey[] memory path = new PathKey[](1);
        path[0] = PathKey({
            intermediateCurrency: NVDA,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(0),
            hookData: bytes("")
        });
        uint256[] memory minHopPriceX36 = new uint256[](0);
        ExactInputParams memory swap = ExactInputParams({
            currencyIn: USDG,
            path: path,
            minHopPriceX36: minHopPriceX36,
            amountIn: uint128(usdgIn),
            amountOutMinimum: uint128(minNvdaOut)
        });

        // SWAP_EXACT_IN, SETTLE, TAKE. This matches successful calls against
        // the currently deployed Robinhood Chain Universal Router.
        bytes memory actions = hex"070b0e";
        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swap);
        actionParams[1] = abi.encode(USDG, usdgIn, true); // payer is this caller via Permit2
        actionParams[2] = abi.encode(NVDA, address(this), 0); // take the full swap output

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, actionParams);
        IUniversalRouterStockTrade(UNIVERSAL_ROUTER).execute(hex"10", inputs, deadline);

        received = IERC20StockTrade(NVDA).balanceOf(address(this)) - beforeBalance;
        if (received < minNvdaOut) revert InsufficientOutput(received, minNvdaOut);
        _safeTransfer(NVDA, msg.sender, received);

        entered = false;
        emit StockPurchased(msg.sender, "NVDA", NVDA, usdgIn, received);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20StockTrade.approve, (spender, amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20StockTrade.transfer, (to, amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20StockTrade.transferFrom, (from, to, amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }
}
