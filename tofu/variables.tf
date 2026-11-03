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
    mainnet NEAR account. See ../nearbi-app README "Payments".
  EOT
  type        = string
  default     = "dry"
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
    SETTLEMENT_RECIPIENT: mainnet NEAR account that receives revenue. Leave empty in dry mode: dry quotes
    then use an inert placeholder (the testnet splitter, splitter.nearbi-agent.testnet, is rejected by
    1Click and is not usable here). Required for intents_mode = "live" (operator decision, not set yet).
  EOT
  type        = string
  default     = ""
  validation {
    condition     = var.intents_mode == "dry" || can(regex("^([a-z0-9_-]+\\.)*near$|^[0-9a-f]{64}$", var.settlement_recipient))
    error_message = "intents_mode = \"live\" needs settlement_recipient set to a mainnet NEAR account (*.near or 64-hex implicit)."
  }
}

