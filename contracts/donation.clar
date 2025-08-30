;; DonationContract - Core contract for handling transparent donations in the Ocean Cleanup Platform
;; This contract manages donations in STX, tracks contributions, routes funds to escrow,
;; issues governance tokens, and provides robust querying and admin features.
;; Assumes integration with other contracts like EscrowContract, InitiativeContract, and GovernanceToken.

;; Traits
(define-trait escrow-trait
  ((deposit-funds (uint uint) (response bool uint)))
)

(define-trait initiative-trait
  ((is-valid-initiative (uint) (response bool uint)))
)

(define-trait governance-token-trait
  ((mint-tokens (principal uint) (response bool uint)))
)

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-PAUSED u101)
(define-constant ERR-INVALID-AMOUNT u102)
(define-constant ERR-INVALID-INITIATIVE u103)
(define-constant ERR-TRANSFER-FAILED u104)
(define-constant ERR-ALREADY-DONATED u105) ;; For potential duplicate checks if needed
(define-constant ERR-MEMO-TOO-LONG u106)
(define-constant ERR-INVALID-RECIPIENT u107)
(define-constant ERR-ESCROW-DEPOSIT-FAILED u108)
(define-constant ERR-GOVERNANCE-MINT-FAILED u109)
(define-constant ERR-INVALID-FEE-PERCENTAGE u110)
(define-constant MAX-MEMO-LEN u256)
(define-constant MAX-FEE-PERCENTAGE u10) ;; 10% max platform fee

;; Data Variables
(define-data-var contract-admin principal tx-sender)
(define-data-var contract-paused bool false)
(define-data-var escrow-contract principal tx-sender) ;; To be set to actual escrow contract
(define-data-var initiative-contract principal tx-sender)
(define-data-var governance-token-contract principal tx-sender)
(define-data-var platform-fee-percentage uint u5) ;; 5% default fee
(define-data-var total-donations uint u0)
(define-data-var donation-counter uint u0)

;; Data Maps
(define-map donor-contributions
  { donor: principal, initiative-id: uint }
  { amount: uint, timestamp: uint, count: uint }
)

(define-map initiative-donations
  { initiative-id: uint }
  { total-amount: uint, donor-count: uint, last-donation: uint }
)

(define-map donation-history
  { donation-id: uint }
  {
    donor: principal,
    initiative-id: uint,
    amount: uint,
    fee: uint,
    timestamp: uint,
    memo: (optional (string-utf8 256))
  }
)

(define-map donor-stats
  { donor: principal }
  { total-donated: uint, initiatives-supported: uint, last-donation: uint }
)

(define-map fee-recipients
  { recipient: principal }
  { percentage: uint, total-received: uint }
)

;; Private Functions
(define-private (calculate-fee (amount uint))
  (/ (* amount (var-get platform-fee-percentage)) u100)
)

(define-private (update-donor-stats (donor principal) (initiative-id uint) (amount uint) (timestamp uint))
  (let
    (
      (current-contrib (map-get? donor-contributions {donor: donor, initiative-id: initiative-id}))
      (current-stats (map-get? donor-stats {donor: donor}))
      (new-contrib-amount (+ (default-to u0 (get amount current-contrib)) amount))
      (new-contrib-count (+ (default-to u0 (get count current-contrib)) u1))
      (new-total-donated (+ (default-to u0 (get total-donated current-stats)) amount))
      (new-initiatives (if (is-some current-contrib)
                          (get initiatives-supported current-stats)
                          (+ (default-to u0 (get initiatives-supported current-stats)) u1)))
    )
    (map-set donor-contributions
      {donor: donor, initiative-id: initiative-id}
      {amount: new-contrib-amount, timestamp: timestamp, count: new-contrib-count}
    )
    (map-set donor-stats
      {donor: donor}
      {total-donated: new-total-donated, initiatives-supported: new-initiatives, last-donation: timestamp}
    )
    (ok true)
  )
)

(define-private (update-initiative-stats (initiative-id uint) (amount uint) (timestamp uint) (is-new-donor bool))
  (let
    (
      (current-stats (map-get? initiative-donations {initiative-id: initiative-id}))
      (new-total (+ (default-to u0 (get total-amount current-stats)) amount))
      (new-donor-count (if is-new-donor
                          (+ (default-to u0 (get donor-count current-stats)) u1)
                          (default-to u0 (get donor-count current-stats))))
    )
    (map-set initiative-donations
      {initiative-id: initiative-id}
      {total-amount: new-total, donor-count: new-donor-count, last-donation: timestamp}
    )
    (ok true)
  )
)

(define-private (distribute-fee (fee uint))
  (fold distribute-fee-iter (map-get? fee-recipients) fee)
)

(define-private (distribute-fee-iter (recipient {recipient: principal, percentage: uint, total-received: uint}) (accum uint))
  (let
    (
      (share (/ (* accum (get percentage recipient)) u100))
    )
    (try! (stx-transfer? share (as-contract tx-sender) (get recipient recipient)))
    (map-set fee-recipients
      {recipient: (get recipient recipient)}
      {percentage: (get percentage recipient), total-received: (+ (get total-received recipient) share)}
    )
    accum
  )
)

;; Public Functions
(define-public (donate (initiative-id uint) (amount uint) (memo (optional (string-utf8 256))))
  (let
    (
      (fee (calculate-fee amount))
      (net-amount (- amount fee))
      (timestamp block-height)
      (donation-id (+ (var-get donation-counter) u1))
      (is-new-donor (is-none (map-get? donor-contributions {donor: tx-sender, initiative-id: initiative-id})))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (is-ok (contract-call? (as-contract (var-get initiative-contract)) is-valid-initiative initiative-id)) (err ERR-INVALID-INITIATIVE))
    (if (is-some memo)
      (asserts! (<= (len (unwrap-panic memo)) MAX-MEMO-LEN) (err ERR-MEMO-TOO-LONG))
      true
    )
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (try! (distribute-fee fee))
    (try! (as-contract (contract-call? (var-get escrow-contract) deposit-funds initiative-id net-amount)))
    (try! (as-contract (contract-call? (var-get governance-token-contract) mint-tokens tx-sender (/ amount u100)))) ;; 1 token per 100 STX
    (map-set donation-history
      {donation-id: donation-id}
      {donor: tx-sender, initiative-id: initiative-id, amount: amount, fee: fee, timestamp: timestamp, memo: memo}
    )
    (var-set donation-counter donation-id)
    (var-set total-donations (+ (var-get total-donations) amount))
    (try! (update-donor-stats tx-sender initiative-id amount timestamp))
    (try! (update-initiative-stats initiative-id amount timestamp is-new-donor))
    (print {event: "donation-received", donation-id: donation-id, donor: tx-sender, amount: amount, initiative-id: initiative-id})
    (ok donation-id)
  )
)

(define-public (set-escrow-contract (new-escrow principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (var-set escrow-contract new-escrow)
    (ok true)
  )
)

(define-public (set-initiative-contract (new-initiative principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (var-set initiative-contract new-initiative)
    (ok true)
  )
)

(define-public (set-governance-token-contract (new-gov principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (var-set governance-token-contract new-gov)
    (ok true)
  )
)

(define-public (set-platform-fee (new-fee uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (asserts! (<= new-fee MAX-FEE-PERCENTAGE) (err ERR-INVALID-FEE-PERCENTAGE))
    (var-set platform-fee-percentage new-fee)
    (ok true)
  )
)

(define-public (add-fee-recipient (recipient principal) (percentage uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (asserts! (<= percentage u100) (err ERR-INVALID-FEE-PERCENTAGE))
    (map-set fee-recipients
      {recipient: recipient}
      {percentage: percentage, total-received: u0}
    )
    (ok true)
  )
)

(define-public (remove-fee-recipient (recipient principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (map-delete fee-recipients {recipient: recipient})
    (ok true)
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (var-set contract-paused true)
    (ok true)
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (var-set contract-paused false)
    (ok true)
  )
)

(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-admin)) (err ERR-UNAUTHORIZED))
    (var-set contract-admin new-admin)
    (ok true)
  )
)

;; Read-Only Functions
(define-read-only (get-total-donations)
  (ok (var-get total-donations))
)

(define-read-only (get-donation-details (donation-id uint))
  (map-get? donation-history {donation-id: donation-id})
)

(define-read-only (get-donor-contribution (donor principal) (initiative-id uint))
  (map-get? donor-contributions {donor: donor, initiative-id: initiative-id})
)

(define-read-only (get-initiative-stats (initiative-id uint))
  (map-get? initiative-donations {initiative-id: initiative-id})
)

(define-read-only (get-donor-stats (donor principal))
  (map-get? donor-stats {donor: donor})
)

(define-read-only (get-platform-fee)
  (ok (var-get platform-fee-percentage))
)

(define-read-only (get-is-paused)
  (ok (var-get contract-paused))
)

(define-read-only (get-admin)
  (ok (var-get contract-admin))
)

(define-read-only (get-escrow-contract)
  (ok (var-get escrow-contract))
)

(define-read-only (get-initiative-contract)
  (ok (var-get initiative-contract))
)

(define-read-only (get-governance-token-contract)
  (ok (var-get governance-token-contract))
)

(define-read-only (get-fee-recipient (recipient principal))
  (map-get? fee-recipients {recipient: recipient})
)