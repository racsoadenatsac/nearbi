variable "region" {
  description = "Region for everything. CloudFront certificates must be in us-east-1, so keep it there."
  type        = string
  default     = "us-east-1"
}

variable "account_id" {
  description = "Guard: refuse to run against any other account."
  type        = string
  default     = "916489698349"
}

variable "domain" {
  type    = string
  default = "nearbi.ai"
}

variable "cert_validated" {
  description = <<-EOT
    Flip to true only after the Namecheap nameservers point at the Route 53 zone and ACM shows the
    certificate as ISSUED (or is about to). Gates: aws_acm_certificate_validation, CloudFront aliases +
    ACM cert, and the apex/www A/AAAA alias records. While false, CloudFront uses *.cloudfront.net.
  EOT
  type        = bool
  default     = true # cert ISSUED 2026-11-02, domain live
}

variable "site_bucket_name" {
  type    = string
  default = "nearbi-site"
}

variable "content_bucket_name" {
  type    = string
  default = "nearbi-content"
}

variable "content_prefix" {
  description = "CONTENT_PREFIX for the app (key prefix inside the content bucket)."
  type        = string
  default     = ""
}

variable "table_name" {
  type    = string
  default = "nearbi"
}

variable "function_name" {
  type    = string
  default = "nearbi-app"
}

variable "app_bundle_path" {
  description = "Built Lambda bundle (bin/build-app.sh produces it in the sibling nearbi-app repo)."
  type        = string
  default     = "../../nearbi-app/dist/lambda/index.mjs"
}

variable "monthly_price_usd" {
  type    = number
  default = 49
}

variable "quick_answer_price_usd" {
  description = "One-off Quick Answer price (USD, settled as USDC). Server-side only."
  type        = number
  default     = 29
}

variable "deep_dive_price_usd" {
  description = "One-off Deep Dive price (USD, settled as USDC). Server-side only."
  type        = number
  default     = 499
}

variable "near_rpc_url" {
  type    = string
  default = "https://rpc.mainnet.near.org"
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "api_throttle_rate" {
  description = "API Gateway steady-state requests/second (cost guard)."
  type        = number
  default     = 20
}

variable "api_throttle_burst" {
  type    = number
  default = 40
}

# ---------------------------------------------------------------- NEAR Intents (1Click) payments
variable "intents_mode" {
  description = <<-EOT
    INTENTS_MODE for the app. "dry": real 1Click DRY quotes, no deposit address, nothing payable, preview
    banner. "live": real deposit addresses; the app refuses to start unless settlement_recipient is a
    mainnet NEAR account. See ../nearbi-app README "Payments". LIVE since 2026-11-03 (operator-approved).
  EOT
  type        = string
  default     = "live"
  validation {
    condition     = contains(["dry", "live"], var.intents_mode)
    error_message = "intents_mode must be \"dry\" or \"live\"."
  }
}

variable "settlement_asset" {
  description = "SETTLEMENT_ASSET: 1Click asset id revenue settles in. Default: native USDC on NEAR."
  type        = string
  default     = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
}

variable "settlement_recipient" {
  description = <<-EOT
    SETTLEMENT_RECIPIENT: mainnet NEAR account that receives revenue. Live: forwarder.nearbi.near, the
    rs-payments forwarder contract (no full-access keys; its only outgoing token call is ft_transfer_call
    into splitter.nearbi.near). Empty is allowed in dry mode only (dry quotes then use an inert placeholder).
  EOT
  type        = string
  default     = "forwarder.nearbi.near"
  validation {
    condition     = var.intents_mode == "dry" || can(regex("^([a-z0-9_-]+\\.)*near$|^[0-9a-f]{64}$", var.settlement_recipient))
    error_message = "intents_mode = \"live\" needs settlement_recipient set to a mainnet NEAR account (*.near or 64-hex implicit)."
  }
}


variable "settlement_delivery" {
  description = <<-EOT
    SETTLEMENT_DELIVERY: "transfer" (plain ft_transfer to settlement_recipient, refundable; the forwarding
    agent then forwards into the splitter) or "ft_transfer_call" (experimental, no refund on failure; the app
    also requires SETTLEMENT_ACCEPT_NO_REFUND=yes, which this module does not set).
  EOT
  type        = string
  default     = "transfer"
  validation {
    condition     = contains(["transfer", "ft_transfer_call"], var.settlement_delivery)
    error_message = "settlement_delivery must be \"transfer\" or \"ft_transfer_call\"."
  }
}

variable "payment_sweep_schedule" {
  description = "EventBridge Scheduler expression for the background payment sweep (1Click status of open live payments)."
  type        = string
  default     = "rate(1 minute)"
}

variable "payment_sweep_enabled" {
  description = "ENABLED or DISABLED. Disabling only stops background confirmation; the checkout page still polls."
  type        = bool
  default     = true
}

variable "agent_user_name" {
  description = "IAM user of the unattended rs-agent (access key in the operator Mac's Keychain, not in state)."
  type        = string
  default     = "nearbi-agent"
}
