<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=social.displayInfo displayWide=(realm.password && social.providers??); section>
    <#if section = "header">
        <div class="login-header">
            <h1>${msg("registerTitle")}</h1>
            <p>Create your Timey account to get started</p>
        </div>
    <#elseif section = "form">
        <form id="kc-register-form" class="${properties.kcFormClass!}" action="${url.registrationAction}" method="post">
            <div class="form-group">
                <label for="firstName">${msg("firstName")}</label>
                <input type="text" class="form-control" id="firstName" name="user.attributes.firstName"
                       value="${(register.formData['user.attributes.firstName']!'')}"
                       aria-invalid="<#if messagesPerField.existsError('user.attributes.firstName','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="lastName">${msg("lastName")}</label>
                <input type="text" class="form-control" id="lastName" name="user.attributes.lastName"
                       value="${(register.formData['user.attributes.lastName']!'')}"
                       aria-invalid="<#if messagesPerField.existsError('user.attributes.lastName','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="email">${msg("email")}</label>
                <input type="email" class="form-control" id="email" name="email"
                       value="${(register.formData.email!'')}"
                       aria-invalid="<#if messagesPerField.existsError('email','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="username">${msg("usernameOrEmail")}</label>
                <input type="text" class="form-control" id="username" name="username"
                       value="${(register.formData.username!'')}"
                       aria-invalid="<#if messagesPerField.existsError('username','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="password">${msg("password")}</label>
                <input type="password" class="form-control" id="password" name="password"
                       aria-invalid="<#if messagesPerField.existsError('password','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="password-confirm">${msg("confirmPassword")}</label>
                <input type="password" class="form-control" id="password-confirm" name="password-confirm"
                       aria-invalid="<#if messagesPerField.existsError('password-confirm','register')>true</#if>"
                />
            </div>

            <div class="form-actions">
                <input class="btn btn-primary btn-block btn-lg" type="submit" value="${msg("doSubmit")}"/>
            </div>
        </form>

        <div class="login-footer">
            <div><a href="${url.loginUrl}">${msg("backToLogin")}</a></div>
        </div>
    </#if>
</@layout.registrationLayout> 