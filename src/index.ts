import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codecommit from '@aws-cdk/aws-codecommit';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as codepipeline_actions from '@aws-cdk/aws-codepipeline-actions';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecr from '@aws-cdk/aws-ecr';
import * as eks from '@aws-cdk/aws-eks';
import * as iam from '@aws-cdk/aws-iam';
import * as rds from '@aws-cdk/aws-rds';
import * as cdk from '@aws-cdk/core';

// Customizable construct inputs
export interface IBlueGreenDeployConstruct {
  // VPC
  readonly vpc?: ec2.IVpc;

  // k8s service name
  readonly serviceName: string;
}

export class BlueGreenDeployConstruct extends cdk.Construct {
  readonly vpc: ec2.IVpc;
  readonly serviceName: string;

  constructor(scope: cdk.Construct, id: string, props: IBlueGreenDeployConstruct) {
    super(scope, id);

    // VPC
    this.vpc = props.vpc ?? new ec2.Vpc(this, 'blue-green-vpc', { natGateways: 1 });

    // k8s service name
    this.serviceName = props.serviceName ?? 'weather';

    // k8s cluster role
    const clusterAdmin = new iam.Role(this, 'adminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

    // EKS cluster
    const cluster = new eks.Cluster(this, 'ekscluster', {
      vpc: this.vpc,
      defaultCapacity: 0,
      mastersRole: clusterAdmin,
      version: eks.KubernetesVersion.V1_19,
      outputClusterName: true,
      outputConfigCommand: true,
      outputMastersRoleArn: true,
    });

    // Custom security group
    const securityGroup = new ec2.SecurityGroup(this, 'eks-security-group', {
      vpc: this.vpc,
      allowAllOutbound: true,
    });

    // Allow inbound port 3306 (Mysql), 80 (Load balancer)
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3306), 'Port 3306 for inbound traffic from IPv4');
    securityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(3306), 'Port 3306 for inbound traffic from IPv6');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Port 80 for inbound traffic from IPv4');
    securityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'Port 80 for inbound traffic from IPv6');

    const nodeRole = new iam.Role(this, 'nodeRole', {
      roleName: 'nodeRole',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    nodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'));
    nodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'));
    nodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'));
    nodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRDSFullAccess'));
    nodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'));
    nodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'));

    const ecrRepo = new ecr.Repository(this, 'ecr-repo');

    const codeRepository = new codecommit.Repository(this, 'code-commit-repo', {
      repositoryName: 'code-base-microservice',
    });

    // Add NodeGroup
    new eks.Nodegroup(this, 'eksNodeGroup', {
      cluster: cluster,
      amiType: eks.NodegroupAmiType.AL2_X86_64,
      instanceTypes: [new ec2.InstanceType('m5a.large')],
      minSize: 2,
      maxSize: 3,
      nodeRole: nodeRole,
    });

    /*
      Since worker nodes are in a private subnet - an sts vpc endpoint is required.
      We will give it access to the Security Group for the Control Plane
    */
    new ec2.InterfaceVpcEndpoint(this, 'stsendpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      vpc: this.vpc,
      open: true,
      securityGroups: [
        securityGroup,
      ],
    });

    // Helm chart
    cluster.addHelmChart('albIngressControllerChart', {
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      values: {
        clusterName: cluster.clusterName,
        serviceAccount: {
          create: false,
          name: this.createServiceAccount(cluster).serviceAccount.serviceAccountName,
        },
      },
    });

    // RDS Aurora MySQL (with data API enabled)
    const db = new rds.ServerlessCluster(this, 'Db', {
      engine: rds.DatabaseClusterEngine.AURORA_MYSQL,
      vpc: cluster.vpc,
      enableDataApi: true,
      securityGroups: [securityGroup],
      scaling: {
        minCapacity: rds.AuroraCapacityUnit.ACU_8,
        maxCapacity: rds.AuroraCapacityUnit.ACU_32,
      },
      credentials: rds.Credentials.fromGeneratedSecret('syscdk'),
    });

    // Create code pipeline for bluegreen deployment
    const pipeline = this.createPipeline(codeRepository, cluster, ecrRepo, db);

    // CDK output
    new cdk.CfnOutput(this, 'RDS-Secret-ARN', { value: db.secret!.secretName});
    new cdk.CfnOutput(this, 'RDS-Hostname', { value: db.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'CodePipeline', { value: pipeline.pipelineName });
    new cdk.CfnOutput(this, 'CodeCommitRepoName', { value: codeRepository.repositoryName });
    new cdk.CfnOutput(this, 'CodeCommitRepoArn', { value: codeRepository.repositoryArn });
    new cdk.CfnOutput(this, 'CodeCommitCloneUrlSsh', { value: codeRepository.repositoryCloneUrlHttp });
    new cdk.CfnOutput(this, 'ECR Repo', { value: ecrRepo.repositoryUri });
  }

  /**
   * Creates code pipeline with build, initial deploy, approve and final blue green swap stage
   * @param coderepository Code commit repository
   * @param cluster EKS cluster
   * @param ecrRepo ECR repository to upload the image after build
   * @param db RDS database instance
   * @returns code pipeline
   */
  createPipeline(coderepository: codecommit.Repository, cluster: eks.Cluster, ecrRepo: ecr.Repository, db: rds.ServerlessCluster) {
    const sourceOutput = new codepipeline.Artifact();

    // Source definition
    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'CodeCommit',
      repository: coderepository,
      output: sourceOutput,
    });

    // Build stage
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: this.createBuild(cluster, ecrRepo),
      input: sourceOutput,
    });

    // Initial deploy, this will deploy both blue and green version of the application
    const initDeploy = new codepipeline_actions.CodeBuildAction({
      actionName: 'InitialDeploy',
      project: this.createInitialPipeline(cluster, db, ecrRepo),
      input: sourceOutput,
    });

    // Code build that will swap blue and green version using kubectl patch
    const blueGreenDeploy = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: this.createBlueGreenDeploy(cluster),
      input: sourceOutput,
    });

    // Manual approve stage - Needed before swapping blue green service
    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Approve',
      additionalInformation: 'Proceed in deploying the service to production via Blue/green?',
    });

    // Main code pipeline
    return new codepipeline.Pipeline(this, 'MyPipeline', {
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'InitialDeploy',
          actions: [initDeploy],
        },
        {
          stageName: 'ApproveStage',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'BlueGreenDeploy',
          actions: [blueGreenDeploy],
        },
      ],
    });
  }

  /**
   * Create build step, which takes care of running the build and pushing it to ECR repository
   * @param cluster EKS cluster
   * @param ecrRepo ECR repo to which the built artifact needs to be pushed
   * @returns reference to code build
   */
  createBuild(cluster: eks.Cluster, ecrRepo: ecr.Repository) {
    const project = new codebuild.Project(this, 'build', {
      environment: {
        privileged: true,
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        computeType: codebuild.ComputeType.LARGE,
      },
      environmentVariables: {
        CLUSTER_NAME: {
          value: `${cluster.clusterName}`,
        },
        ECR_REPO_URI: {
          value: ecrRepo.repositoryUri,
        },
        AWS_ACCOUNT_ID: {
          value: cdk.Aws.ACCOUNT_ID,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {   
          pre_build: {
            commands: [
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}',              
            ],
          },       
          post_build: {
            commands: [
              'mvn clean install',
              'docker build -t $ECR_REPO_URI:${TAG} .',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
              'docker push $ECR_REPO_URI:${TAG}',
            ],
          },
        },
      }),
    });

    ecrRepo.grantPullPush(project.role!);
    return project;
  }

  /**
   * Code build - Takes care of deploying the blue and green version of the k8s service
   * @param cluster EKS cluster
   * @param db RDS database instance
   * @param ecrRepo ECR repo to which the built artifact got
   * @returns reference of code build
   */
  createInitialPipeline(cluster: eks.Cluster, db: rds.ServerlessCluster, ecrRepo: ecr.Repository) {
    const project = new codebuild.Project(this, 'init-deploy', {
      environment: {
        privileged: true,
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        computeType: codebuild.ComputeType.LARGE,
      },
      environmentVariables: {
        CLUSTER_NAME: {
          value: `${cluster.clusterName}`,
        },
        SERVICE_NAME: {
          value: this.serviceName,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}',
              'aws eks --region $AWS_REGION update-kubeconfig --name $CLUSTER_NAME',
            ],
          },
          post_build: {
            commands: [ 
              '#!/bin/bash',
              'export TMP=/tmp/tmpDeploy.yaml',
              'export RDS_USERNAME=$(aws secretsmanager get-secret-value --secret-id '+db.secret!.secretName+' | jq .SecretString | jq fromjson.username)',
              'export RDS_PASSWORD=$(aws secretsmanager get-secret-value --secret-id '+db.secret!.secretName+' | jq .SecretString | jq fromjson.password)',
              'export RDS_HOSTNAME=$(aws secretsmanager get-secret-value --secret-id '+db.secret!.secretName+' | jq .SecretString | jq fromjson.host\)',
              'export IMAGE_URL='+ecrRepo.repositoryUri+':${TAG}',
              'export BLUE_COUNT=$(kubectl get svc | grep ${SERVICE_NAME}-blue | wc -l)',
              'export GREENSERVICE=$(kubectl get svc ${SERVICE_NAME}-green -o json | jq -r .spec.selector.app)',                
              'if [ ! $GREENSERVICE ]; then export DEPLOYMENT=green; for filename in k8s/*.yaml; do envsubst < $filename > ${TMP} | kubectl apply -f ${TMP} || continue ; done; fi;',
              'if [ ${BLUE_COUNT} -eq 0 ]; then export DEPLOYMENT=blue; for filename in k8s/*.yaml; do envsubst < $filename > ${TMP} | kubectl apply -f ${TMP} || continue ; done; fi;',                            
              'if [ $GREENSERVICE ]; then export TARGET_DEPLOYMENT=$(kubectl get svc ${SERVICE_NAME}-blue -o json | jq -r .spec.selector.app) ; export TARGET_CONTAINER=$(kubectl get deployment ${TARGET_DEPLOYMENT} -o json | jq -r .spec.template.spec.containers[0].name); kubectl set image deployment/${TARGET_DEPLOYMENT} ${TARGET_CONTAINER}=${IMAGE_URL} --record; fi',
              'echo "Initial Deploy complete"',
            ],
          },
        },
      }),
    });

    cluster.awsAuth.addMastersRole(project.role!);    
    project.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'));    
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [`${cluster.clusterArn}`],
    }));
    return project;
  }

  /**
   * Code build - Takes care of swapping blue and green service using kubectl patch
   * @param cluster EKS cluster
   * @returns reference of code build
   */
  createBlueGreenDeploy(cluster: eks.Cluster) {
    const project = new codebuild.Project(this, 'blue-green-deploy', {
      environment: {
        privileged: true,
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        computeType: codebuild.ComputeType.LARGE,
      },
      environmentVariables: {
        CLUSTER_NAME: {
          value: `${cluster.clusterName}`,
        },
        SERVICE_NAME: {
          value: this.serviceName,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'aws eks --region $AWS_REGION update-kubeconfig --name $CLUSTER_NAME',
            ],
          },
          post_build: {
            commands: [
              "export BLUE_SERVICE=$(kubectl get svc ${SERVICE_NAME}-blue -o json | jq -r .spec.selector.app)",
              "export GREEN_SERVICE=$(kubectl get svc ${SERVICE_NAME}-green -o json | jq -r .spec.selector.app)",              
              "kubectl patch svc ${SERVICE_NAME}-blue -p '{\"spec\":{\"selector\": {\"app\": \"'$GREEN_SERVICE'\"}}}'",              
              "kubectl patch svc ${SERVICE_NAME}-green -p '{\"spec\":{\"selector\": {\"app\": \"'$BLUE_SERVICE'\"}}}'",              
              'echo "Blue green swap complete"',
            ],
          },
        },
      }),
    });

    // Assign permission
    cluster.awsAuth.addMastersRole(project.role!);
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [`${cluster.clusterArn}`],
    }));
    return project;
  }

  /*
    Here we are adding policy statements to the Aws-Load-Balancer-Controller's Role(which is created with the Service Account)
    Policies Added from https://raw.githubusercontent.com/kubernetes-sigs/aws-alb-ingress-controller/main/docs/install/iam_policy.json
  */
  createServiceAccount(cluster: eks.Cluster) {

    // Creating it via CDK will create the OpenIdentity Provider Connection automatically
    // Adding the Service Account to an object so that it can be referenced across other methods in the class
    const serviceAccount = {
      serviceAccount: new eks.ServiceAccount(this, 'awsloadbalancersa', {
        name: 'aws-load-balancer-controller',
        cluster: cluster,
      }),
    };

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateServiceLinkedRole',
        'ec2:DescribeAccountAttributes',
        'ec2:DescribeAddresses',
        'ec2:DescribeInternetGateways',
        'ec2:DescribeVpcs',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeInstances',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeTags',
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeLoadBalancerAttributes',
        'elasticloadbalancing:DescribeListeners',
        'elasticloadbalancing:DescribeListenerCertificates',
        'elasticloadbalancing:DescribeSSLPolicies',
        'elasticloadbalancing:DescribeRules',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetGroupAttributes',
        'elasticloadbalancing:DescribeTargetHealth',
        'elasticloadbalancing:DescribeTags',
      ],
      resources: ['*'],
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:DescribeUserPoolClient',
        'acm:ListCertificates',
        'acm:DescribeCertificate',
        'iam:ListServerCertificates',
        'iam:GetServerCertificate',
        'waf-regional:GetWebACL',
        'waf-regional:GetWebACLForResource',
        'waf-regional:AssociateWebACL',
        'waf-regional:DisassociateWebACL',
        'wafv2:GetWebACL',
        'wafv2:GetWebACLForResource',
        'wafv2:AssociateWebACL',
        'wafv2:DisassociateWebACL',
        'shield:GetSubscriptionState',
        'shield:DescribeProtection',
        'shield:CreateProtection',
        'shield:DeleteProtection',
      ],
      resources: ['*'],
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupEgress',
      ],
      resources: ['*'],
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateSecurityGroup',
      ],
      resources: ['*'],
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateTags',
      ],
      resources: ['arn:aws:ec2:*:*:security-group/*'],
      conditions: {
        StringEquals: {
          'ec2:CreateAction': 'CreateSecurityGroup',
        },
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateTags',
        'ec2:DeleteTags',
      ],
      resources: ['arn:aws:ec2:*:*:security-group/*'],
      conditions: {
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:DeleteSecurityGroup',
      ],
      resources: ['*'],
      conditions: {
        Null: {
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:CreateLoadBalancer',
        'elasticloadbalancing:CreateTargetGroup',
      ],
      resources: ['*'],
      conditions: {
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:CreateRule',
        'elasticloadbalancing:DeleteRule',
      ],
      resources: ['*'],
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:AddTags',
        'elasticloadbalancing:RemoveTags',
      ],
      resources: ['arn:aws:elasticloadbalancing:*:*:loadbalancer/*',
        'arn:aws:elasticloadbalancing:*:*:targetgroup/*'],
      conditions: {
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:SetIpAddressType',
        'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:ModifyTargetGroup',
        'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:DeleteTargetGroup',
      ],
      resources: ['*'],
      conditions: {
        Null: {
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    }));

    serviceAccount.serviceAccount.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:SetWebAcl',
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:AddListenerCertificates',
        'elasticloadbalancing:RemoveListenerCertificates',
        'elasticloadbalancing:ModifyRule',
      ],
      resources: ['*'],
    }));

    return serviceAccount;
  }
}
