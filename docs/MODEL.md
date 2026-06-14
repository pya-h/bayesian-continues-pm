# Complete Technical Specification: Web2 Bayesian Market Maker (BMM) for Continuous Prediction Markets

---

## 1. System Overview and Objectives

### 1.1 What This System Is

A **Web2 continuous-outcome prediction market** using a **Bayesian Market Maker (BMM)** as its pricing and liquidity engine. The system allows users to trade contracts on continuous numerical outcomes (e.g., "What will BTC price be at end of month?") with full buy/sell capability, real-time consensus probability density extraction, and proximity-based settlement rewards.

### 1.2 Core Requirements

| Requirement | Description |
|-------------|-------------|
| **Continuous outcomes** | Outcome space is any real number θ ∈ ℝ or subset thereof |
| **Full buy/sell** | Users can open and close positions at any time before resolution |
| **Consensus PDF** | The market's internal belief state must be interpretable as the crowd's aggregated probability density |
| **Proximity reward** | Settlement rewards users based on closeness to true value, not just exact hits |
| **Capital efficiency** | No requirement for external liquidity providers or locked collateral pools |
| **Real-time** | Prices update instantly with each trade; no batching delays |

### 1.3 What This Specification Contains

- Complete mathematical formalism
- Exact algorithms for all operations
- Data structures and state management
- User interaction flows
- Risk management and solvency proofs
- Settlement mechanics
- Parameter selection and tuning
- Edge cases and failure modes

---

## 2. Mathematical Foundation

### 2.1 Outcome Space

Let θ ∈ Θ ⊆ ℝ be the continuous outcome variable.

**Examples:**
- BTC price at month-end: Θ = [0, ∞)
- Temperature tomorrow: Θ = [-50, 50] (Celsius)
- Election vote share: Θ = [0, 100]

### 2.2 Belief State

The market maker maintains a **probability distribution** over Θ:

```
p_t(θ) = P(θ | D_t)
```

where D_t = {all trades and market data up to time t}

This is the **consensus PDF**. It represents the aggregated information of all market participants.

### 2.3 Parametric Representation

For computational tractability, we represent p_t(θ) parametrically.

#### 2.3.1 Gaussian Belief (Single-Mode)

```
p(θ) = N(θ; μ, σ²) = (1/√(2πσ²)) × exp(-(θ-μ)²/(2σ²))
```

**Parameters:**
- μ ∈ ℝ: mean (expected value)
- σ² > 0: variance (uncertainty)

**State vector:** `S = (μ, σ², t)` where t is timestamp

#### 2.3.2 Gaussian Mixture Belief (Multi-Mode)

For markets with multiple hypotheses:

```
p(θ) = Σ_{k=1}^K π_k × N(θ; μ_k, σ_k²)
```

**Constraints:**
- π_k ≥ 0, Σ π_k = 1
- μ_k ∈ ℝ, σ_k² > 0

**State vector:** `S = {(π_k, μ_k, σ_k²)}_{k=1}^K`

#### 2.3.3 Student-t Belief (Robust)

For heavy-tailed distributions:

```
p(θ) = T(θ; ν, μ, σ²) = Γ((ν+1)/2) / [Γ(ν/2)√(πνσ²)] × [1 + (θ-μ)²/(νσ²)]^(-(ν+1)/2)
```

**Parameters:**
- ν > 0: degrees of freedom (ν = ∞ → Gaussian)
- μ ∈ ℝ: location
- σ² > 0: scale

**Use when:** Outliers are common; market may be manipulated.

---

## 3. Contract Types and Payoff Functions

### 3.1 Contract Definition

A **contract** C is defined by its payoff function:

```
f_C: Θ → ℝ
```

At resolution (when true value θ* is known), holder of q units receives:

```
Payout = q × f_C(θ*)
```

### 3.2 Standard Contract Types

| Contract | Payoff f(θ) | Description | Use Case |
|----------|-------------|-------------|----------|
| **Linear** | f(θ) = θ | Pays the true value | Direct exposure |
| **Call** | f(θ) = max(0, θ - K) | Pays excess above strike K | Bullish bet |
| **Put** | f(θ) = max(0, K - θ) | Pays deficit below strike K | Bearish bet |
| **Binary Call** | f(θ) = 1 if θ ≥ K, else 0 | Binary above/below | Simple direction |
| **Binary Put** | f(θ) = 1 if θ ≤ K, else 0 | Binary below/above | Simple direction |
| **Spread** | f(θ) = 1 if a ≤ θ ≤ b, else 0 | Pays if in range | Range bet |
| **Gaussian** | f(θ) = exp(-(θ-c)²/(2w²)) | Proximity reward | Precision bet |
| **Quadratic** | f(θ) = -(θ-c)² | Negative distance squared | Research/scoring |
| **Custom** | Any integrable f(θ) | User-defined | Arbitrary |

### 3.3 Payoff Normalization

To ensure fair comparison and prevent infinite liability:

**For unbounded payoffs (Linear, Call, Put):**
```
f_norm(θ) = f(θ) / E_0[|f(θ)|]
```

Where E_0 is expectation under initial prior.

**For bounded payoffs (Binary, Spread, Gaussian):**
```
f_norm(θ) = f(θ)  (already bounded)
```

---

## 4. Pricing Mechanism

### 4.1 Fair Price

The **fair price** of contract C under belief p_t is:

```
Price_fair(C, p_t) = E_{p_t}[f_C(θ)] = ∫_Θ f_C(θ) × p_t(θ) dθ
```

### 4.2 Closed-Form Pricing Formulas

For Gaussian p_t(θ) = N(μ, σ²):

#### 4.2.1 Linear Contract

```
Price_linear = μ
```

#### 4.2.2 Call Contract

```
Price_call(K) = σ × φ(d) + (μ - K) × Φ(d)
where d = (μ - K) / σ
```

**Derivation:**
```
E[max(0, θ-K)] = ∫_K^∞ (θ-K) × N(θ;μ,σ²) dθ
               = σ × φ((K-μ)/σ) + (μ-K) × (1 - Φ((K-μ)/σ))
               = σ × φ(d) + (μ-K) × Φ(d)   [using φ(-x) = φ(x), 1-Φ(-x) = Φ(x)]
```

#### 4.2.3 Put Contract

```
Price_put(K) = σ × φ(d) - (μ - K) × Φ(-d)
where d = (μ - K) / σ
```

**Derivation:**
```
E[max(0, K-θ)] = ∫_{-∞}^K (K-θ) × N(θ;μ,σ²) dθ
               = σ × φ((K-μ)/σ) - (μ-K) × Φ((K-μ)/σ)
               = σ × φ(d) - (μ-K) × Φ(-d)
```

#### 4.2.4 Binary Call

```
Price_binary_call(K) = Φ(d) = Φ((μ - K) / σ)
```

#### 4.2.5 Binary Put

```
Price_binary_put(K) = Φ(-d) = Φ((K - μ) / σ)
```

#### 4.2.6 Spread Contract [a, b]

```
Price_spread(a,b) = Φ((b-μ)/σ) - Φ((a-μ)/σ)
```

#### 4.2.7 Gaussian Payoff (center c, width w)

```
Price_gaussian(c,w) = √(w²/(w²+σ²)) × exp(-(c-μ)²/(2(w²+σ²)))
```

**Derivation:**
```
∫ exp(-(θ-c)²/(2w²)) × N(θ;μ,σ²) dθ
= ∫ exp(-(θ-c)²/(2w²)) × exp(-(θ-μ)²/(2σ²)) / √(2πσ²) dθ
= [combine exponents, complete the square]
= √(w²/(w²+σ²)) × exp(-(c-μ)²/(2(w²+σ²)))
```

### 4.3 Bid-Ask Spread

The market maker quotes:

```
Bid(C) = Price_fair(C) - Spread(C, q)
Ask(C) = Price_fair(C) + Spread(C, q)
```

Where q is the quantity (positive for buy, negative for sell).

**Spread function:**

```
Spread(C, q) = BaseSpread + InventoryAdjustment(C, q) + AdverseSelection(C, q) + VolatilityAdjustment
```

#### 4.3.1 Base Spread

```
BaseSpread = s₀ × Price_fair(C)
```

s₀ ∈ [0.001, 0.02] (0.1% to 2%)

#### 4.3.2 Inventory Adjustment

```
InventoryAdjustment(C, q) = γ × |Inventory(C) + q| × Price_fair(C)
```

Where:
- Inventory(C) = current net position in contract C
- γ ∈ [0.0001, 0.001] (0.01% to 0.1% per unit exposure)

**Purpose:** Compensates for accumulated risk.

#### 4.3.3 Adverse Selection Premium

```
AdverseSelection(C, q) = λ × |q| × σ × |∂Price/∂μ|
```

Where:
- λ ∈ [0.1, 1.0]: adverse selection coefficient
- ∂Price/∂μ = price sensitivity to mean (varies by contract type)

**For Call:**
```
∂Price_call/∂μ = Φ(d)
```

**For Put:**
```
∂Price_put/∂μ = -Φ(-d)
```

**Purpose:** Larger trades are more likely to be informed; MM widens spread to protect against information asymmetry.

#### 4.3.4 Volatility Adjustment

```
VolatilityAdjustment = η × σ × Price_fair(C)
```

Where η ∈ [0.01, 0.1]

**Purpose:** Higher uncertainty = wider spreads.

---

## 5. Bayesian Update: The Core Mechanism

### 5.1 Information Model

Each trade reveals information about the trader's belief.

**Assumption:** Traders observe a noisy signal of the true value:

```
s_trader = θ_true + ε,  ε ~ N(0, σ_ε²)
```

The trader acts optimally given their signal.

### 5.2 Signal Extraction from Trade

Given a trade (contract C, quantity q, strike K if applicable):

**Step 1: Determine trade direction and intensity**

```
direction = sign(q)  # +1 for buy, -1 for sell
intensity = |q| / Q_max  # normalized trade size, Q_max = maximum allowed trade
```

**Step 2: Infer signal location**

For directional contracts (Call, Put, Binary):

```
If buying Call(K):    s_inferred = K + α × σ × (1 + intensity)
If selling Call(K):   s_inferred = K - α × σ × (1 + intensity)
If buying Put(K):     s_inferred = K - α × σ × (1 + intensity)
If selling Put(K):    s_inferred = K + α × σ × (1 + intensity)
```

Where α ∈ [0.5, 2.0] controls signal strength.

For Linear contracts:

```
If buying (q > 0):    s_inferred = μ + β × σ × intensity
If selling (q < 0):   s_inferred = μ - β × σ × intensity
```

Where β ∈ [0.5, 1.5]

**Step 3: Signal reliability**

```
signal_weight = intensity × (1 - e^(-|q|/q_threshold))
```

Trades below q_threshold have minimal belief impact (noise).

### 5.3 Bayesian Update Formula

Given prior N(μ, σ²) and inferred signal s with reliability w:

**Precision-weighted update:**

```
precision_prior = 1/σ²
precision_signal = w / σ_ε²

μ_new = (precision_prior × μ + precision_signal × s) / (precision_prior + precision_signal)
σ_new² = 1 / (precision_prior + precision_signal)
```

**Alternative: Simplified update with learning rate**

```
μ_new = μ + lr × (s - μ) × signal_weight
σ_new² = σ² × (1 - decay × signal_weight)
```

Where:
- lr ∈ [0.001, 0.1]: learning rate
- decay ∈ [0, 0.1]: uncertainty reduction rate

**Constraint:** σ_new² ≥ σ_min² (minimum uncertainty to prevent overconfidence)

### 5.4 Multi-Mode Update (Gaussian Mixture)

For K components:

**Per-component update:**

```
For each k = 1..K:
    likelihood_k = N(s; μ_k, σ_k² + σ_ε²)
    μ_k_new = (μ_k/σ_k² + s/σ_ε²) / (1/σ_k² + 1/σ_ε²)
    σ_k_new² = 1 / (1/σ_k² + 1/σ_ε²)
```

**Weight update:**

```
π_k_new ∝ π_k × likelihood_k
π_k_new = π_k_new / Σ_j π_j_new  [normalize]
```

**Component management:**
- If π_k < π_min (e.g., 0.01): merge with nearest component
- If two components are close (|μ_i - μ_j| < 2σ): merge them
- If belief is strongly bimodal and no component exists: split component (optional advanced feature)

---

## 6. Inventory and Risk Management

### 6.1 Inventory State

The market maker tracks:

| Variable | Type | Description |
|----------|------|-------------|
| `inventory` | Dict[ContractID, float] | Net position per contract |
| `cash` | float | Available capital |
| `exposure(θ)` | function | Net payoff as function of θ |

**Exposure function:**

```
exposure(θ) = Σ_C inventory[C] × f_C(θ)
```

### 6.2 Solvency Condition

At all times, the market maker must satisfy:

```
cash + E_p[max(0, -exposure(θ))] ≥ 0
```

Equivalently:

```
cash ≥ -min_θ exposure(θ)   [worst-case if bounded]
```

Or probabilistically:

```
cash ≥ VaR_α(-exposure(θ))   [Value at Risk at confidence α]
```

For Gaussian beliefs:

```
cash ≥ E_p[-exposure(θ) | exposure(θ) < 0] × P(exposure(θ) < 0) + z × σ_exposure
```

Where:
- z = safety factor (2.33 for 99%, 3.09 for 99.9%)
- σ_exposure = standard deviation of exposure under p

### 6.3 Required Reserve Calculation

```
def required_reserve(exposure_func, belief, confidence=0.99):
    """
    Compute required capital to cover exposure with given confidence
    """
    # Monte Carlo estimation
    samples = belief.sample(n=100000)
    payouts = [exposure_func(s) for s in samples]
    losses = [-p for p in payouts if p < 0]
    
    if not losses:
        return 0
    
    var = np.percentile(losses, confidence * 100)
    return var
```

### 6.4 Dynamic Hedging

To reduce required reserve, the MM can take offsetting positions:

**Internal hedge:** Trade with itself to reduce net exposure
**External hedge:** Trade in correlated markets (if available)

**Hedge trigger:**

```
if required_reserve > cash × 0.8:
    # Take hedge position
    hedge_contract = find_best_hedge(exposure)
    execute_internal_trade(hedge_contract, -exposure_amount)
```

---

## 7. Trade Execution Algorithm

### 7.1 Input

- User ID
- Contract C
- Quantity q (positive = buy, negative = sell)
- Maximum acceptable price (slippage protection)

### 7.2 Algorithm

```
function execute_trade(user, C, q, max_price):
    # 1. Compute fair price
    fair = price_fair(C, current_belief)
    
    # 2. Compute spread
    spread = compute_spread(C, q, inventory, current_belief)
    
    # 3. Determine execution price (clamped to the payoff bounds — a bounded
    #    contract's ask never exceeds its max payout, nor a bid its min; the
    #    adverse-selection term can diverge as ν→2 on fat-tailed beliefs)
    if q > 0:  # user buying
        exec_price = min(fair + spread, payoff_max(C))   # payoff_max = +inf if unbounded
    else:  # user selling
        exec_price = max(payoff_min(C), fair - spread)   # payoff_min = 0 if unbounded
    
    # 4. Slippage check
    if q > 0 and exec_price > max_price:
        return REJECTED("Price exceeds maximum")
    if q < 0 and exec_price < max_price:
        return REJECTED("Price below minimum")
    
    # 5. Compute total cost
    total_cost = q * exec_price
    
    # 6. Check user balance
    if q > 0 and user.balance < total_cost:
        return REJECTED("Insufficient balance")
    if q < 0 and abs(q) > user.position[C]:
        return REJECTED("Insufficient position to sell")
    
    # 7. Update inventory
    inventory[C] += q
    
    # 8. Update cash
    cash += total_cost
    
    # 9. Extract signal and update belief
    signal = extract_signal(C, q, current_belief)
    new_belief = bayesian_update(current_belief, signal)
    
    # 10. Check solvency
    new_exposure = compute_exposure(inventory)
    reserve_needed = required_reserve(new_exposure, new_belief)
    if cash < reserve_needed:
        # Rollback or require additional capital
        return REJECTED("Trade would make market insolvent")
    
    # 11. Commit updates
    current_belief = new_belief
    user.balance -= total_cost
    user.position[C] += q
    
    # 12. Record trade
    record_trade(user, C, q, exec_price, timestamp)
    
    return EXECUTED(exec_price, total_cost)
```

### 7.3 Partial Execution

For very large trades that would breach solvency:

```
max_executable = find_max_executable(C, q, current_belief, cash)
if max_executable < abs(q):
    # Execute partial
    execute_trade(user, C, sign(q) * max_executable, max_price)
    return PARTIAL_EXECUTED(max_executable, remaining=abs(q)-max_executable)
```

---

## 8. Settlement and Resolution

### 8.1 Resolution Trigger

At market expiration time T:

1. Oracle provides true value θ*
2. Market transitions to RESOLVED state
3. No new trades allowed
4. Settlement begins

### 8.2 Payout Calculation

For each user and each position:

```
payout = Σ_C position[C] × f_C(θ*)
```

**Special case: Negative payouts**

If f_C(θ*) < 0 (possible for some custom contracts), user may owe money.

**Handling:**
- If user balance + payout ≥ 0: deduct from balance
- If user balance + payout < 0: user is bankrupt; protocol absorbs loss (socialized or from insurance fund)

### 8.3 Proximity Reward Mechanisms

#### 8.3.1 Gaussian Payoff (Built-in)

Contracts with `f(θ) = exp(-(θ-c)²/(2w²))` naturally reward proximity.

**Properties:**
- Maximum payout = 1 at θ = c
- Payout decreases smoothly as |θ - c| increases
- Width w controls tolerance for error

**Example:**
- User bets on c = $65,000, w = $1,000
- If θ* = $65,200: payout = exp(-200²/2M) = exp(-0.02) ≈ 0.98
- If θ* = $66,000: payout = exp(-1000²/2M) = exp(-0.5) ≈ 0.61

#### 8.3.2 Post-Hoc Proximity Adjustment

For standard contracts (Call, Put), apply proximity multiplier at settlement:

```
proximity_multiplier = exp(-(θ* - nearest_strike)² / (2 × adj_width²))
adjusted_payout = base_payout × proximity_multiplier
```

**Example:**
- User holds Call K=$70,000
- θ* = $69,500 (just below strike)
- Base payout = max(0, 69500-70000) = 0
- With adj_width = $2,000:
  - proximity_multiplier = exp(-(-500)²/8M) = exp(-0.031) ≈ 0.97
  - adjusted_payout = 0 × 0.97 = 0 (still zero for Call)

Better for Puts or Linear with floor:

- User holds position centered at c=$65,000
- θ* = $64,800
- Base payout = 64800 (for linear)
- proximity_multiplier = exp(-(-200)²/8M) = exp(-0.005) ≈ 0.995
- adjusted_payout = 64800 × 0.995 = 64,476

#### 8.3.3 Tiered Settlement

Define tiers around the true value:

| Tier | Range | Payout Factor |
|------|-------|---------------|
| Exact | θ* ± 0.1% | 100% |
| Close | θ* ± 1% | 80% |
| Near | θ* ± 5% | 50% |
| Far | θ* ± 10% | 20% |
| Miss | > 10% | 0% |

**For contract with strike K:**

```
distance = |θ* - K| / θ*
tier = determine_tier(distance)
payout = base_payout × tier_factor
```

---

## 9. User Account System

### 9.1 Account Structure

```
UserAccount:
    user_id: UUID
    balance: float (cash available)
    positions: Dict[ContractID, float]
    margin_used: float
    margin_available: float
    open_orders: List[Order]
    trade_history: List[Trade]
    created_at: timestamp
    updated_at: timestamp
```

### 9.2 Margin Requirements

For leveraged positions or short selling:

```
margin_required = Σ_C |position[C]| × margin_rate[C] × current_price[C]
margin_available = balance - margin_used
```

**Margin call:**

```
if margin_available < 0:
    # Liquidate positions until margin_available ≥ 0
    liquidate_positions(user)
```

### 9.3 Position Limits

A per-market cap on the size any single account may hold, sized from market depth
— not from any account class or legal status:

```
max_position_size = f(market_liquidity)
```

Concentration is additionally bounded by the circuit breaker in §15.1 (a single
account exceeding ~20% of open interest). Where leverage is enabled, the per-market
leverage limit is defined in §9.2 and configured per market (v3), not per account.

---

## 10. Market Lifecycle

### 10.1 States

```
CREATED → OPEN → SUSPENDED → RESOLVED → SETTLED → CLOSED
```

| State | Description | Allowed Actions |
|-------|-------------|---------------|
| **CREATED** | Market initialized, not yet trading | Admin: configure, set parameters |
| **OPEN** | Active trading | Users: trade, deposit, withdraw |
| **SUSPENDED** | Trading halted (oracle issue, emergency) | Admin: resolve, cancel |
| **RESOLVED** | Oracle provided θ*, no new trades | System: calculate payouts |
| **SETTLED** | Payouts distributed | Users: withdraw winnings |
| **CLOSED** | Final state | None |

### 10.2 State Transitions

```
CREATED → OPEN:      Admin activates market, initial liquidity deposited
OPEN → SUSPENDED:    Admin or circuit breaker triggers
SUSPENDED → OPEN:    Admin resumes
OPEN → RESOLVED:     Oracle reports θ* at expiration
RESOLVED → SETTLED:  All payouts calculated and applied
SETTLED → CLOSED:    Final reconciliation complete
SUSPENDED → CLOSED:  Market cancelled, refunds issued
```

---

## 11. Oracle System

### 11.1 Oracle Interface

```
Oracle:
    market_id: UUID
    source: str (e.g., "coinbase_api", "manual_admin", "aggregated")
    resolution_time: timestamp
    value: float
    confidence: float (0-1)
    metadata: dict
    reported_at: timestamp
    disputed: bool
    dispute_resolution: Optional[str]
```

### 11.2 Oracle Sources

| Source | Reliability | Latency | Cost | Use Case |
|--------|-------------|---------|------|----------|
| **API feed** (Coinbase, Binance) | High | Low | Free | Crypto prices |
| **Weather API** | High | Medium | Free/Paid | Weather outcomes |
| **Election API** | Medium | High | Free | Election results |
| **Manual admin** | Low | High | N/A | Subjective outcomes |
| **Aggregated (multiple sources)** | Very High | Medium | Medium | High-value markets |

### 11.3 Dispute Resolution

```
if user_disputes(oracle_value):
    # Escalate to dispute resolution
    # Options:
    # 1. Admin override (centralized)
    # 2. Vote by token holders (decentralized)
    # 3. Secondary oracle (redundancy)
    # 4. Time-delayed finality (wait for confirmation)
```

---

## 12. Data Structures and Storage

### 12.1 Core Entities

```
Market:
    market_id: UUID
    title: str
    description: str
    outcome_type: CONTINUOUS
    outcome_unit: str (e.g., "USD", "Celsius", "%")
    outcome_range: [min, max] or unbounded
    created_at: timestamp
    opens_at: timestamp
    closes_at: timestamp
    resolves_at: timestamp
    status: MarketState
    initial_belief: BeliefState
    current_belief: BeliefState
    parameters: MarketParameters
    oracle_config: OracleConfig

BeliefState:
    type: GAUSSIAN | MIXTURE | STUDENT_T
    parameters: dict
    last_updated: timestamp
    update_history: List[BeliefUpdate]

BeliefUpdate:
    timestamp: timestamp
    previous_state: BeliefState
    new_state: BeliefState
    triggering_trade: TradeID
    signal_extracted: float
    signal_weight: float

Trade:
    trade_id: UUID
    market_id: UUID
    user_id: UUID
    contract_id: UUID
    quantity: float
    price: float
    total_cost: float
    timestamp: timestamp
    belief_before: BeliefState
    belief_after: BeliefState

Contract:
    contract_id: UUID
    market_id: UUID
    type: LINEAR | CALL | PUT | BINARY | SPREAD | GAUSSIAN | CUSTOM
    parameters: dict (strike, width, center, etc.)
    payoff_function: str (serialized or reference)
    created_at: timestamp
    expires_at: timestamp

Position:
    position_id: UUID
    user_id: UUID
    contract_id: UUID
    quantity: float
    average_entry_price: float
    unrealized_pnl: float
    realized_pnl: float
    opened_at: timestamp
    last_updated: timestamp
```

### 12.2 Database Schema (Relational)

```sql
-- Markets
CREATE TABLE markets (
    market_id UUID PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    outcome_type VARCHAR(20) DEFAULT 'CONTINUOUS',
    outcome_unit VARCHAR(20),
    outcome_min FLOAT,
    outcome_max FLOAT,
    created_at TIMESTAMP DEFAULT NOW(),
    opens_at TIMESTAMP,
    closes_at TIMESTAMP,
    resolves_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'CREATED',
    initial_mu FLOAT,
    initial_sigma FLOAT,
    current_mu FLOAT,
    current_sigma FLOAT,
    cash FLOAT DEFAULT 0,
    reserve_required FLOAT DEFAULT 0,
    parameters JSONB
);

-- Belief Updates (time-series)
CREATE TABLE belief_updates (
    update_id UUID PRIMARY KEY,
    market_id UUID REFERENCES markets(market_id),
    previous_mu FLOAT,
    previous_sigma FLOAT,
    new_mu FLOAT,
    new_sigma FLOAT,
    signal_extracted FLOAT,
    signal_weight FLOAT,
    triggering_trade_id UUID,
    timestamp TIMESTAMP DEFAULT NOW()
);

-- Trades
CREATE TABLE trades (
    trade_id UUID PRIMARY KEY,
    market_id UUID REFERENCES markets(market_id),
    user_id UUID REFERENCES users(user_id),
    contract_id UUID REFERENCES contracts(contract_id),
    quantity FLOAT NOT NULL,
    price FLOAT NOT NULL,
    total_cost FLOAT NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW(),
    belief_mu_before FLOAT,
    belief_sigma_before FLOAT,
    belief_mu_after FLOAT,
    belief_sigma_after FLOAT
);

-- User Positions
CREATE TABLE positions (
    position_id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(user_id),
    contract_id UUID REFERENCES contracts(contract_id),
    quantity FLOAT NOT NULL DEFAULT 0,
    average_entry_price FLOAT DEFAULT 0,
    realized_pnl FLOAT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Contracts
CREATE TABLE contracts (
    contract_id UUID PRIMARY KEY,
    market_id UUID REFERENCES markets(market_id),
    contract_type VARCHAR(20) NOT NULL,
    strike FLOAT,
    center FLOAT,
    width FLOAT,
    lower_bound FLOAT,
    upper_bound FLOAT,
    payoff_function TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);

-- Oracles
CREATE TABLE oracles (
    oracle_id UUID PRIMARY KEY,
    market_id UUID REFERENCES markets(market_id),
    source VARCHAR(100),
    resolved_value FLOAT,
    confidence FLOAT,
    reported_at TIMESTAMP,
    disputed BOOLEAN DEFAULT FALSE,
    dispute_resolution TEXT
);
```

---

## 13. API Specification

### 13.1 REST Endpoints

```
GET  /markets                    # List all markets
GET  /markets/{id}               # Get market details and current belief
GET  /markets/{id}/beliefs       # Get belief history (time-series)
POST /markets/{id}/trades        # Execute trade
GET  /markets/{id}/trades        # Get trade history
GET  /markets/{id}/contracts     # List available contracts
GET  /markets/{id}/orderbook     # Get current bid/ask for contracts

GET  /users/{id}/portfolio       # Get user's positions and PnL
GET  /users/{id}/trades          # Get user's trade history
POST /users/{id}/deposit         # Deposit funds
POST /users/{id}/withdraw        # Withdraw funds

GET  /contracts/{id}/price      # Get current price for contract
GET  /contracts/{id}/history    # Price history
```

### 13.2 WebSocket Events

```
market:{id}:belief_update       # Real-time belief updates
market:{id}:trade_executed      # New trade notification
market:{id}:price_change        # Price tick
user:{id}:position_update       # User's position changed
user:{id}:order_status          # Order status changes
system:alert                    # System-wide alerts
```

---

## 14. Parameter Tuning and Calibration

### 14.1 Initial Parameter Selection

| Parameter | Formula | Example (BTC market) |
|-----------|---------|---------------------|
| μ₀ | Current market price | $65,000 |
| σ₀ | 10-20% of μ₀ | $6,500-$13,000 |
| σ_min | 1-5% of μ₀ | $650-$3,250 |
| σ_ε | 5-15% of σ₀ | $325-$1,950 |
| s₀ | 0.5-2% | 1% |
| γ | 0.01-0.1% per unit | 0.05% |
| λ | 0.1-1.0 | 0.5 |
| α | 0.5-2.0 | 1.0 |
| β | 0.5-1.5 | 1.0 |
| lr | 0.001-0.1 | 0.01 |
| decay | 0-0.1 | 0.05 |
| Q_max | 100-1000 units | 500 |

### 14.2 Calibration Process

**Step 1: Historical backtesting**

```
for market in historical_markets:
    simulate_bmm(market.parameters, historical_trades)
    measure:
        - price accuracy (vs realized outcome)
        - belief calibration (does 80% CI contain outcome 80% of time?)
        - MM profitability
        - user participation
```

**Step 2: Live A/B testing**

Run parallel markets with different parameter sets.

**Step 3: Adaptive parameters**

```
σ_ε_t = EWMA(σ_ε, |signal_error_t|, alpha=0.1)
s₀_t = max(s₀_min, s₀ × (1 + volatility_regime))
```

---

## 15. Risk Management and Circuit Breakers

### 15.1 Circuit Breakers

| Trigger | Action | Threshold |
|---------|--------|-----------|
| Rapid price movement | Suspend trading | >10% in 1 minute |
| Belief divergence | Alert admin | σ > 3× σ₀ |
| Insolvency risk | Reject trades | cash < 1.2 × reserve_required |
| Oracle failure | Suspend + dispute | No oracle update within 2× expected time |
| User concentration | Limit position | Single user > 20% of open interest |
| Wash trading | Ban user | Self-trading detected |

### 15.2 Insurance Fund

```
insurance_fund += fee_percentage × total_volume
insurance_fund_used += cover_bankruptcy(user)
```

**Fee percentage:** 0.1-0.5% of trade volume

---

## 16. Complete Mathematical Summary

### 16.1 Core Equations

| Operation | Equation |
|-----------|----------|
| **Gaussian PDF** | `N(θ;μ,σ²) = (1/√(2πσ²)) exp(-(θ-μ)²/(2σ²))` |
| **Fair price** | `Price(f) = ∫ f(θ) N(θ;μ,σ²) dθ` |
| **Call price** | `σφ(d) + (μ-K)Φ(d), d=(μ-K)/σ` |
| **Put price** | `σφ(d) - (μ-K)Φ(-d)` |
| **Binary call** | `Φ((μ-K)/σ)` |
| **Gaussian payoff** | `√(w²/(w²+σ²)) exp(-(c-μ)²/(2(w²+σ²)))` |
| **Bid/Ask** | `Price ± (s₀ + γ|inv| + λ|q|σ|∂P/∂μ|) × Price` |
| **Bayesian update** | `μ_new = (μ/σ² + w·s/σ_ε²)/(1/σ² + w/σ_ε²)` |
| **Posterior variance** | `σ_new² = 1/(1/σ² + w/σ_ε²)` |
| **Exposure** | `exposure(θ) = Σ_C inv[C] × f_C(θ)` |
| **Required reserve** | `VaR_α(-exposure(θ))` |

### 16.2 Algorithm Pseudocode

```
FUNCTION initialize_market(μ₀, σ₀, cash):
    belief ← Gaussian(μ₀, σ₀)
    inventory ← empty map
    return MarketState(belief, inventory, cash)

FUNCTION price_contract(contract, belief):
    IF contract.type == LINEAR:
        return belief.μ
    ELSE IF contract.type == CALL:
        d ← (belief.μ - contract.K) / belief.σ
        return belief.σ × φ(d) + (belief.μ - contract.K) × Φ(d)
    ELSE IF contract.type == PUT:
        d ← (belief.μ - contract.K) / belief.σ
        return belief.σ × φ(d) - (belief.μ - contract.K) × Φ(-d)
    ELSE IF contract.type == GAUSSIAN:
        w ← contract.width
        c ← contract.center
        return √(w²/(w²+belief.σ²)) × exp(-(c-belief.μ)²/(2(w²+belief.σ²)))
    ELSE:
        return numerical_integration(contract.payoff, belief)

FUNCTION compute_spread(contract, q, inventory, belief):
    fair ← price_contract(contract, belief)
    base ← s₀ × fair
    inv_adj ← γ × |inventory.get(contract, 0) + q| × fair
    adv_sel ← λ × |q| × belief.σ × |derivative_price_wrt_mean(contract, belief)|
    vol_adj ← η × belief.σ × fair
    return base + inv_adj + adv_sel + vol_adj

FUNCTION extract_signal(contract, q, belief):
    intensity ← |q| / Q_max
    direction ← sign(q)
    IF contract.type == CALL:
        IF direction > 0:
            return contract.K + α × belief.σ × (1 + intensity)
        ELSE:
            return contract.K - α × belief.σ × (1 + intensity)
    ELSE IF contract.type == PUT:
        IF direction > 0:
            return contract.K - α × belief.σ × (1 + intensity)
        ELSE:
            return contract.K + α × belief.σ × (1 + intensity)
    ELSE IF contract.type == LINEAR:
        return belief.μ + direction × β × belief.σ × intensity
    ELSE:
        return belief.μ  # default

FUNCTION bayesian_update(belief, signal, weight):
    precision_prior ← 1 / belief.σ²
    precision_signal ← weight / σ_ε²
    μ_new ← (precision_prior × belief.μ + precision_signal × signal) / (precision_prior + precision_signal)
    σ_new_sq ← 1 / (precision_prior + precision_signal)
    σ_new_sq ← max(σ_new_sq, σ_min²)
    return Gaussian(μ_new, √σ_new_sq)

FUNCTION execute_trade(user, contract, q, max_price):
    fair ← price_contract(contract, current_belief)
    spread ← compute_spread(contract, q, inventory, current_belief)
    # clamped to payoff bounds: ask ≤ payoff_max, bid ≥ payoff_min (0/+inf if unbounded)
    exec_price ← min(fair + spread, payoff_max(contract)) IF q > 0 ELSE max(payoff_min(contract), fair - spread)
    
    IF q > 0 AND exec_price > max_price: RETURN REJECTED
    IF q < 0 AND exec_price < max_price: RETURN REJECTED
    
    total_cost ← q × exec_price
    
    IF user.balance < total_cost: RETURN REJECTED
    IF q < 0 AND user.position[contract] < |q|: RETURN REJECTED
    
    # Tentative updates
    new_inventory ← inventory + {contract: q}
    new_cash ← cash + total_cost
    signal ← extract_signal(contract, q, current_belief)
    new_belief ← bayesian_update(current_belief, signal, weight)
    new_exposure ← compute_exposure(new_inventory)
    reserve_needed ← required_reserve(new_exposure, new_belief)
    
    IF new_cash < reserve_needed: RETURN REJECTED("Insolvent")
    
    # Commit
    inventory ← new_inventory
    cash ← new_cash
    current_belief ← new_belief
    user.balance -= total_cost
    user.position[contract] += q
    
    RETURN EXECUTED(exec_price, total_cost)

FUNCTION settle_market(θ_true):
    FOR EACH user:
        FOR EACH (contract, quantity) in user.positions:
            payout ← quantity × contract.payoff(θ_true)
            user.balance += payout
            user.realized_pnl += payout - quantity × user.average_entry_price[contract]
    CLEAR all positions
    market.status ← SETTLED
```

---

## 17. Testing and Validation

### 17.1 Unit Tests

| Test | Input | Expected Output |
|------|-------|---------------|
| Gaussian pricing | μ=65000, σ=5000, K=70000 | Call price ≈ $415 |
| Bayesian update | μ=65000, σ=5000, s=72500, w=0.5 | μ_new ≈ 71034, σ_new ≈ 1857 |
| Spread calculation | q=10, inv=0, s₀=0.01 | spread ≈ 0.01 × fair |
| Solvency check | cash=1M, exposure=-2M at θ=60k | REJECTED |
| Settlement | θ*=63450, Call K=70k | payout = 0 |

### 17.2 Integration Tests

- Full market lifecycle: create → trade → resolve → settle
- Multiple concurrent trades
- Edge cases: σ→σ_min, belief divergence, oracle failure

### 17.3 Simulation Tests

```
Monte Carlo simulation:
    for i in 1..10000:
        θ_true ~ true_distribution
        simulate_traders(θ_true, n_traders=100)
        run_bmm()
        measure:
            - belief accuracy: |μ_final - θ_true|
            - calibration: P(θ_true in CI_80)
            - MM profitability: cash_final - cash_initial
            - user welfare: average trader profit
```

---

## 18. Deployment Architecture

### 18.1 System Components

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Web Frontend  │────▶│   API Gateway   │────▶│  Trade Engine   │
│  (React/Vue)    │     │  (Rate limiting)│     │  (BMM logic)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                              ┌─────────────────┐      │
                              │   Database      │◀─────┘
                              │  (PostgreSQL)   │
                              └─────────────────┘
                                       │
                              ┌─────────────────┐
                              │  Cache/Queue    │
                              │  (Redis)        │
                              └─────────────────┘
                                       │
                              ┌─────────────────┐
                              │  Oracle Service │
                              │  (Price feeds)   │
                              └─────────────────┘
```

### 18.2 Scaling Considerations

| Component | Scaling Strategy |
|-----------|---------------|
| API Gateway | Horizontal scaling, load balancer |
| Trade Engine | Single leader (sequential consistency), read replicas |
| Database | Read replicas, sharding by market_id |
| Cache | Redis cluster |
| Oracle | Multiple redundant sources |

---

## 19. Complete Glossary

| Term | Definition |
|------|------------|
| **Belief** | Probability distribution p(θ) representing market maker's state of knowledge |
| **Consensus PDF** | The belief distribution interpreted as the crowd's aggregated probability density |
| **Contract** | Tradable instrument with payoff function f(θ) |
| **Exposure** | Net payoff function of all open positions |
| **Fair price** | Expected payoff under current belief: E[f(θ)] |
| **Gaussian** | Normal distribution N(μ, σ²) |
| **Inventory** | Net position held by market maker in each contract |
| **Kernel** | Function determining proximity reward in settlement |
| **Oracle** | External source providing true outcome θ* |
| **Position** | User's holding of a contract (quantity) |
| **Posterior** | Updated belief after observing new evidence |
| **Prior** | Initial belief before any trades |
| **Proximity reward** | Settlement mechanism paying based on distance to true value |
| **Reserve** | Capital required to cover potential losses |
| **Signal** | Inferred trader information extracted from trade |
| **Slippage** | Difference between expected and executed price |
| **Solvency** | Condition that cash ≥ required reserve |
| **Spread** | Difference between bid and ask prices |