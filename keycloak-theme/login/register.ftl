<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=social.displayInfo displayWide=(realm.password && social.providers??); section>
    <#if section = "header">
        <div class="login-header">
            <h1>${msg("registerTitle")}</h1>
            <p>Create your account and start rockin'</p>
        </div>
    <#elseif section = "form">
        <form id="kc-register-form" class="${properties.kcFormClass!}" action="${url.registrationAction}" method="post" autocomplete="off">
            <div class="form-group">
                <label for="username">${msg("username")}</label>
                <input type="text" class="form-control" id="username" name="username"
                       autocomplete="off"
                       autofill="off"
                       aria-invalid="<#if messagesPerField.existsError('username','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="email">${msg("email")}</label>
                <input type="email" class="form-control" id="email" name="email"
                       autocomplete="off"
                       autofill="off"
                       aria-invalid="<#if messagesPerField.existsError('email','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="password">${msg("password")}</label>
                <input type="password" class="form-control" id="password" name="password"
                       autocomplete="new-password"
                       autofill="off"
                       aria-invalid="<#if messagesPerField.existsError('password','register')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="password-confirm">${msg("confirmPassword")}</label>
                <input type="password" class="form-control" id="password-confirm" name="password-confirm"
                       autocomplete="new-password"
                       autofill="off"
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
