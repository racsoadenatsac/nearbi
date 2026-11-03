# App secrets. The app only reads them from the environment (SSM at cold start is not implemented),
# so they are stored in SSM SecureString as the system of record and injected into the Lambda env.
# NOTE: values are also in the tofu state (private, encrypted, versioned state bucket).
resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "random_password" "admin_token" {
  length  = 48
  special = false
}

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

locals {
  secrets = {
    SESSION_SECRET       = random_password.session_secret.result
    ADMIN_TOKEN          = random_password.admin_token.result
    ORIGIN_VERIFY_SECRET = random_password.origin_verify.result
  }
}

resource "aws_ssm_parameter" "secret" {
  for_each = local.secrets

  name   = "/nearbi/app/${each.key}"
  type   = "SecureString"
  value  = each.value
  tier   = "Standard"
  key_id = "alias/aws/ssm"
}
