# ---------------------------------------------------------------- rs-agent: unattended agent identity
# IAM user for the shop agent on the operator's Mac (rs-agent bin/agent-tick, bin/forwarder-runner,
# bin/agent-orders, rs-ledger bin/publish). No console access (no aws_iam_user_login_profile) and no group.
# The access key is NOT managed here, so its secret never lands in the tofu state: it is created once with
# `aws iam create-access-key` and piped straight into the Mac's Keychain (see README "Agent identity").
#
# The policy is exactly the aws CLI calls those scripts make (grep `aws` in rs-agent + rs-ledger):
#   forwarder-runner  sts get-caller-identity; dynamodb query FWDQ, get-item PAY#, update-item PAY#
#                     (forwardedTx), delete-item FWDQ
#   agent-orders      dynamodb query ORDERQ, get-item ACCT#/ORDER# + PAY#, update-item PAY# (agentClaim/
#                     agentStatus/backfill); ssm describe-parameters (dry-run: "is the admin token there?"),
#                     ssm get-parameter /nearbi/app/ADMIN_TOKEN --with-decryption (aws/ssm key; its key policy
#                     already allows any authorized principal of the account via SSM, so no kms:Decrypt);
#                     s3api head-object/put-object under <content_prefix>reports/qa-*
#   rs-ledger publish s3 cp / sync --delete under nearbi-site/ledger/; cloudfront create-invalidation + wait
# The content bucket name/prefix are fixed in rs-agent (no lambda:GetFunctionConfiguration, which would
# expose every app secret in the Lambda environment).
resource "aws_iam_user" "agent" {
  name = var.agent_user_name
  tags = { Purpose = "rs-agent unattended agent: agent-tick forwarder-runner agent-orders ledger-publish" }
}

locals {
  agent_ddb_condition_test = "ForAllValues:StringLike"
}

data "aws_iam_policy_document" "agent" {
  # sts:GetCallerIdentity needs no permission; listed so the intent is explicit.
  statement {
    sid       = "Identity"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  # Reads: the two queues (FWDQ, ORDERQ) by partition key; PAY#<id> and ACCT#<acct> (ORDER#<id>) items.
  statement {
    sid       = "TableRead"
    actions   = ["dynamodb:Query", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.main.arn]
    condition {
      test     = local.agent_ddb_condition_test
      variable = "dynamodb:LeadingKeys"
      values   = ["FWDQ", "ORDERQ", "PAY#*", "ACCT#*"]
    }
  }

  # Writes: conditional UpdateItem on payment items only (forwardedTx*, agent* attributes).
  statement {
    sid       = "PaymentUpdate"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.main.arn]
    condition {
      test     = local.agent_ddb_condition_test
      variable = "dynamodb:LeadingKeys"
      values   = ["PAY#*"]
    }
  }

  # Deletes: forward-queue entries only.
  statement {
    sid       = "ForwardQueueDelete"
    actions   = ["dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.main.arn]
    condition {
      test     = local.agent_ddb_condition_test
      variable = "dynamodb:LeadingKeys"
      values   = ["FWDQ"]
    }
  }

  statement {
    sid       = "AdminTokenRead"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.secret["ADMIN_TOKEN"].arn]
  }

  # DescribeParameters has no resource-level permissions (metadata only, never values).
  statement {
    sid       = "AdminTokenPresence"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  # Order deliverables: reports/qa-<paymentId>/... (never overwritten by the agent; HeadObject first).
  statement {
    sid       = "DeliverableWrite"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.content.arn}/${var.content_prefix}reports/qa-*"]
  }

  # Lets HeadObject of a not-yet-published key return 404 instead of 403 (the agent's "not there yet" check).
  statement {
    sid       = "DeliverableList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.content.arn]
  }

  # Public ledger files (rs-ledger bin/publish: cp + sync --delete, inside ledger/ only).
  statement {
    sid       = "LedgerWrite"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.site.arn}/ledger/*"]
  }

  statement {
    sid       = "LedgerList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["ledger/", "ledger/*"]
    }
  }

  statement {
    sid       = "LedgerInvalidate"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.site.arn]
  }
}

resource "aws_iam_user_policy" "agent" {
  name   = "${var.agent_user_name}-least-privilege"
  user   = aws_iam_user.agent.name
  policy = data.aws_iam_policy_document.agent.json
}
