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
