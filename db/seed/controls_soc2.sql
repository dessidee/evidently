-- SOC 2 Common Criteria (CC-series) reference catalog.
-- Descriptions below are Evidently's own paraphrased summaries of each
-- criterion's intent for a small startup audience -- NOT a verbatim
-- reproduction of the AICPA Trust Services Criteria text. Teams doing an
-- actual SOC 2 audit should still work from the official AICPA TSC document
-- with their auditor; this catalog is a practical checklist, not the
-- authoritative standard.

insert into controls (framework, code, title, description, category) values
('soc2', 'CC1.1', 'Commitment to integrity and ethical values', 'Leadership has defined and communicated expected standards of conduct for employees and contractors.', 'Control Environment'),
('soc2', 'CC1.2', 'Board/leadership oversight', 'There is oversight of the security program independent of day-to-day management (a board, advisor, or designated owner).', 'Control Environment'),
('soc2', 'CC1.3', 'Organizational structure and reporting lines', 'Roles, responsibilities, and reporting lines relevant to security are defined, even informally at small scale.', 'Control Environment'),
('soc2', 'CC1.4', 'Commitment to competence', 'People in security-relevant roles have the skills needed, or access to training/support to develop them.', 'Control Environment'),
('soc2', 'CC1.5', 'Accountability for security responsibilities', 'Individuals are held accountable for their assigned security responsibilities (e.g. via performance reviews or role definitions).', 'Control Environment'),

('soc2', 'CC2.1', 'Quality information to support the control system', 'Relevant security and operational information is captured and available to the people who need it.', 'Communication and Information'),
('soc2', 'CC2.2', 'Internal communication of objectives and responsibilities', 'Security policies and responsibilities are communicated internally (handbook, onboarding, Slack channel, etc.).', 'Communication and Information'),
('soc2', 'CC2.3', 'External communication', 'Customers, vendors, or regulators can report issues and receive relevant security information (status page, security.txt, contact).', 'Communication and Information'),

('soc2', 'CC3.1', 'Risk identification', 'The company identifies risks to its objectives (a lightweight risk register or equivalent).', 'Risk Assessment'),
('soc2', 'CC3.2', 'Risk analysis and response', 'Identified risks are analyzed and there is a documented decision on how each is addressed, accepted, or transferred.', 'Risk Assessment'),
('soc2', 'CC3.3', 'Fraud risk consideration', 'Potential for fraud (including insider misuse) is explicitly considered in risk assessment.', 'Risk Assessment'),
('soc2', 'CC3.4', 'Change-driven risk reassessment', 'Significant changes (new product, new region, new vendor) trigger a re-look at risk.', 'Risk Assessment'),

('soc2', 'CC4.1', 'Ongoing monitoring of controls', 'Controls are periodically checked to confirm they are actually operating (not just documented on paper).', 'Monitoring Activities'),
('soc2', 'CC4.2', 'Evaluation and communication of deficiencies', 'Gaps found during monitoring are tracked and communicated to the people who can fix them.', 'Monitoring Activities'),

('soc2', 'CC5.1', 'Control activities to mitigate risk', 'Specific control activities exist that map back to identified risks (not just generic best practice).', 'Control Activities'),
('soc2', 'CC5.2', 'Technology controls', 'Technical controls (access control, logging, encryption, etc.) are selected and implemented to support the control objectives.', 'Control Activities'),
('soc2', 'CC5.3', 'Policies and procedures', 'Control activities are backed by written policies, even if short, and procedures for carrying them out.', 'Control Activities'),

('soc2', 'CC6.1', 'Logical access security controls', 'Access to systems and data is restricted via authentication and authorization mechanisms appropriate to sensitivity.', 'Logical and Physical Access'),
('soc2', 'CC6.2', 'User registration and de-provisioning', 'Accounts are provisioned based on approved requests and de-provisioned promptly on role change or offboarding.', 'Logical and Physical Access'),
('soc2', 'CC6.3', 'Role-based access and least privilege', 'Access rights are assigned based on role, reviewed periodically, and modified/removed when no longer needed.', 'Logical and Physical Access'),
('soc2', 'CC6.4', 'Physical access restrictions', 'Physical access to facilities/hardware holding sensitive data is restricted (may be N/A for fully cloud-hosted startups, with justification).', 'Logical and Physical Access'),
('soc2', 'CC6.6', 'Protection against external threats', 'Boundary protections (firewalls, WAF, VPC segmentation) reduce exposure to external attackers.', 'Logical and Physical Access'),
('soc2', 'CC6.7', 'Data transmission and movement controls', 'Data in transit is protected (TLS) and movement of data (exports, backups) is controlled and tracked.', 'Logical and Physical Access'),
('soc2', 'CC6.8', 'Malware/unauthorized software prevention', 'Controls exist to prevent or detect introduction of malicious or unauthorized software.', 'Logical and Physical Access'),

('soc2', 'CC7.1', 'Vulnerability detection', 'The company detects vulnerabilities in its systems (dependency scanning, periodic review, etc.).', 'System Operations'),
('soc2', 'CC7.2', 'Security event monitoring and response', 'Security events are monitored and there is a defined process for responding to anomalies/incidents.', 'System Operations'),
('soc2', 'CC7.3', 'Incident evaluation', 'Detected incidents are evaluated to determine impact and required response.', 'System Operations'),
('soc2', 'CC7.4', 'Incident response execution', 'There is a documented incident response process that is actually followed when incidents occur.', 'System Operations'),
('soc2', 'CC7.5', 'Recovery from incidents', 'Post-incident, the company recovers systems and captures lessons learned/remediation.', 'System Operations'),

('soc2', 'CC8.1', 'Change management', 'Changes to systems (code, infra, config) go through an approval and testing process before production.', 'Change Management'),

('soc2', 'CC9.1', 'Business continuity / disaster recovery risk mitigation', 'Risks to availability are mitigated via backups, redundancy, or a documented continuity plan appropriate to company size.', 'Risk Mitigation'),
('soc2', 'CC9.2', 'Vendor and third-party risk management', 'Vendors/subprocessors with access to data or systems are identified and assessed for risk (e.g. reviewing their own SOC 2 report).', 'Risk Mitigation')
on conflict (framework, code) do nothing;
